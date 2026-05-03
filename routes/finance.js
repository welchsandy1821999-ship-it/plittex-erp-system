const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { auditLog } = require('../utils/db_init');
const cache = require('../utils/cache');
const fs = require('fs');
const path = require('path');
const Big = require('big.js');
const { requireAdmin, requirePlannedPlanManage, authenticateToken } = require('../middleware/auth');
const { validateTransaction, validateTransactionEdit, validateTransfer, validateCounterparty, validateInvoice, validateAccount, validateAccountEdit, validateCategory, validateCorrection, validatePayment, validatePlannedExpense, validatePlannedPay, validateCostGroup } = require('../middleware/validator');
const { allocateUnlinkedClientIncome } = require('../utils/allocateClientAdvance');
const { money, reconcileOrderSettlement } = require('../utils/orderSettlement');

// 🚀 Единая функция поиска документов в тексте (Защита от опечаток)
function extractDocNumber(description) {
    if (!description) return null;
    const match = String(description).match(/(СЧ|ЗК)-(\d+)/i);
    return match ? match[0].toUpperCase() : null;
}

/** SSoT: корректировка долга контрагента (КРМ) — та же статья, что «Корректировка Баланса» в справочнике ДДС. */
const FINANCE_CP_BALANCE_CORRECTION_CATEGORY = 'Корректировка Баланса';
const TRANSFER_CATEGORY_BASE = 'Перевод';
const TECHNICAL_WILD_BASE = 'Технические операции';
const TECHNICAL_CATEGORIES = Object.freeze({
    TECHNICAL: 'Техническая проводка',
    OPENING: 'Ввод начальных остатков',
    BALANCE_CORRECTION: FINANCE_CP_BALANCE_CORRECTION_CATEGORY
});
const INCOME_DEFAULT_CATEGORY = 'Прочие доходы';
const INCOME_REFUND_IMPREST_CATEGORY = 'Возврат подотчетных средств';
const INCOME_SAFE_CATEGORIES = Object.freeze([
    'Продажа продукции',
    'Оплата по счету',
    'Получение займов',
    INCOME_REFUND_IMPREST_CATEGORY,
    'Взнос учредителя',
    'Нераспределенное',
    INCOME_DEFAULT_CATEGORY
]);
const EXPENSE_SAFE_CATEGORIES = Object.freeze([
    'Закупка сырья',
    'Налоги, штрафы и взносы',
    'Услуги банка и РКО',
    'Зарплата и Авансы',
    'Транспортные расходы',
    'Транспортные расходы',
    'Услуги банка и РКО',
    'Возврат заемных средств',
    'Нераспределенное',
    'Техническая проводка',
    'Ввод начальных остатков',
    'Корректировка Баланса'
]);
const TRANSFER_CATEGORY_CHILDREN = Object.freeze({
    INTERNAL: 'Перевод / Внутренний',
    IMPREST_ISSUE: 'Перевод / Подотчет выдача',
    IMPREST_TRANSIT: 'Перевод / Подотчет транзит',
    IMPORT_OWN: 'Перевод / Импорт распознанный',
    NEEDS_REVIEW: 'Перевод / Требует разбора'
});
const BIDIRECTIONAL_SYSTEM_CATEGORIES = Object.freeze([
    TRANSFER_CATEGORY_BASE,
    ...Object.values(TRANSFER_CATEGORY_CHILDREN),
    TECHNICAL_CATEGORIES.TECHNICAL,
    TECHNICAL_CATEGORIES.OPENING,
    TECHNICAL_CATEGORIES.BALANCE_CORRECTION
]);
const CANONICAL_COST_GROUPS = Object.freeze(['direct', 'opex', 'capex']);
const COST_GROUP_ALIASES = Object.freeze({
    direct: 'direct',
    cogs: 'direct',
    opex: 'opex',
    overhead: 'opex',
    capex: 'capex',
    capital: 'capex'
});

function normalizeCategoryName(v) {
    return String(v || '').trim().toLowerCase();
}

function normalizeCostGroup(v, fallback = null) {
    const n = normalizeCategoryName(v);
    if (!n) return fallback;
    return COST_GROUP_ALIASES[n] || fallback;
}

function ensureCanonicalCostGroup(v, fallback = 'opex') {
    const normalized = normalizeCostGroup(v, fallback);
    if (CANONICAL_COST_GROUPS.includes(normalized)) return normalized;
    return fallback;
}

function sanitizeIdArray(values, { max = 500 } = {}) {
    if (!Array.isArray(values)) return [];
    const uniq = new Set();
    for (const raw of values) {
        const n = Number(raw);
        if (Number.isInteger(n) && n > 0) uniq.add(n);
        if (uniq.size > max) break;
    }
    return Array.from(uniq);
}

function sanitizeNameArray(values, { max = 100 } = {}) {
    if (!Array.isArray(values)) return [];
    const uniq = new Set();
    for (const raw of values) {
        const s = String(raw || '').trim();
        if (s) uniq.add(s);
        if (uniq.size > max) break;
    }
    return Array.from(uniq);
}

function getEffectiveCostGroupSql(txAlias = 't', catAlias = 'tc', overrideAlias = 'tc_override', fallback = 'opex') {
    const t = txAlias ? `${txAlias}.` : '';
    const c = catAlias ? `${catAlias}.` : '';
    const o = overrideAlias ? `${overrideAlias}.` : '';
    return `
    COALESCE(
        CASE
            WHEN LOWER(TRIM(COALESCE(${t}cost_group_override, ''))) IN ('direct', 'cogs') THEN 'direct'
            WHEN LOWER(TRIM(COALESCE(${t}cost_group_override, ''))) IN ('opex', 'overhead') THEN 'opex'
            WHEN LOWER(TRIM(COALESCE(${t}cost_group_override, ''))) IN ('capex', 'capital') THEN 'capex'
            ELSE NULL
        END,
        CASE
            WHEN LOWER(TRIM(COALESCE(${o}cost_group, ''))) IN ('direct', 'cogs') THEN 'direct'
            WHEN LOWER(TRIM(COALESCE(${o}cost_group, ''))) IN ('opex', 'overhead') THEN 'opex'
            WHEN LOWER(TRIM(COALESCE(${o}cost_group, ''))) IN ('capex', 'capital') THEN 'capex'
            ELSE NULL
        END,
        CASE
            WHEN LOWER(TRIM(COALESCE(${c}cost_group, ''))) IN ('direct', 'cogs') THEN 'direct'
            WHEN LOWER(TRIM(COALESCE(${c}cost_group, ''))) IN ('opex', 'overhead') THEN 'opex'
            WHEN LOWER(TRIM(COALESCE(${c}cost_group, ''))) IN ('capex', 'capital') THEN 'capex'
            ELSE NULL
        END,
        '${fallback}'
    )`;
}

function isTechnicalWildCategory(categoryName) {
    const n = normalizeCategoryName(categoryName);
    if (!n) return false;
    return (
        n.startsWith('технические операции') ||
        (n.includes('техничес') && n.includes('операц')) ||
        (n.includes('тех') && n.includes('операц'))
    );
}

function isBidirectionalSystemCategory(categoryName) {
    const n = normalizeCategoryName(categoryName);
    return BIDIRECTIONAL_SYSTEM_CATEGORIES.some((x) => normalizeCategoryName(x) === n);
}

function getEffectiveCategorySql(alias = 't') {
    const p = alias ? `${alias}.` : '';
    return `LOWER(TRIM(COALESCE(${p}category_override, ${p}category, '')))`;
}

function getTransferCategoryPredicateSql(alias = 't') {
    const e = getEffectiveCategorySql(alias);
    return `(${e} = 'перевод' OR ${e} LIKE 'перевод /%')`;
}

function resolveTransferOverrideByContext({ description = '', paymentMethod = '', employeeMode = '', category = '' }) {
    const desc = String(description || '').toLowerCase();
    const method = String(paymentMethod || '').toLowerCase();
    const mode = String(employeeMode || '').toLowerCase();
    const cat = normalizeCategoryName(category);
    if (!(cat === 'перевод' || cat.startsWith('перевод /'))) return null;

    if (mode === 'imprest') return TRANSFER_CATEGORY_CHILDREN.IMPREST_ISSUE;
    if (mode === 'instant_expense') return TRANSFER_CATEGORY_CHILDREN.IMPREST_TRANSIT;
    if (desc.includes('мгновенный транзит под отчет')) return TRANSFER_CATEGORY_CHILDREN.IMPREST_TRANSIT;
    if (desc.includes('выдача под отчет') || desc.includes('получение под отчет')) return TRANSFER_CATEGORY_CHILDREN.IMPREST_ISSUE;
    if (desc.includes('внутренний перевод')) return TRANSFER_CATEGORY_CHILDREN.INTERNAL;
    if (
        method.includes('импорт') ||
        desc.includes('между своими') ||
        desc.includes('собственных средств') ||
        desc.includes('перевод средств')
    ) {
        return TRANSFER_CATEGORY_CHILDREN.IMPORT_OWN;
    }
    return TRANSFER_CATEGORY_CHILDREN.NEEDS_REVIEW;
}

async function ensureTransferCategories(client) {
    let baseId = null;
    const baseFindRes = await client.query(
        `SELECT id FROM transaction_categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1::text)) LIMIT 1`,
        [TRANSFER_CATEGORY_BASE]
    );
    if (baseFindRes.rows.length > 0) {
        baseId = baseFindRes.rows[0].id;
    } else {
        const baseInsRes = await client.query(
            `
            INSERT INTO transaction_categories (name, type, cost_group, parent_id, monthly_limit)
            SELECT $1::text, 'expense', 'capital', NULL, 0
            WHERE NOT EXISTS (
                SELECT 1 FROM transaction_categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1::text))
            )
            RETURNING id
        `,
            [TRANSFER_CATEGORY_BASE]
        );
        if (baseInsRes.rows.length > 0) {
            baseId = baseInsRes.rows[0].id;
        } else {
            const baseRefetchRes = await client.query(
                `SELECT id FROM transaction_categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1::text)) LIMIT 1`,
                [TRANSFER_CATEGORY_BASE]
            );
            if (baseRefetchRes.rows.length > 0) baseId = baseRefetchRes.rows[0].id;
        }
    }
    if (!baseId) return;
    const children = Object.values(TRANSFER_CATEGORY_CHILDREN);
    for (const childName of children) {
        await client.query(
            `
            INSERT INTO transaction_categories (name, type, cost_group, parent_id, monthly_limit)
            SELECT $1::text, 'expense', 'capital', $2::int, 0
            WHERE NOT EXISTS (
                SELECT 1 FROM transaction_categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1::text))
            )
        `,
            [childName, baseId]
        );
    }
}

async function ensureTechnicalCategories(client) {
    const names = Object.values(TECHNICAL_CATEGORIES);
    for (const nm of names) {
        await client.query(
            `
            INSERT INTO transaction_categories (name, type, cost_group, parent_id, monthly_limit)
            SELECT $1::text, 'expense', 'capital', NULL, 0
            WHERE NOT EXISTS (
                SELECT 1 FROM transaction_categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1::text))
            )
        `,
            [nm]
        );
    }
}

async function ensureCategoryExists(client, name, type = 'expense', costGroup = null, parentId = null) {
    const n = String(name || '').trim();
    if (!n) return;
    await client.query(
        `
        INSERT INTO transaction_categories (name, type, cost_group, parent_id, monthly_limit)
        SELECT $1::text, $2::text, $3::text, $4::int, 0
        WHERE NOT EXISTS (
            SELECT 1 FROM transaction_categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1::text))
        )
    `,
        [n, type, costGroup, parentId]
    );
}

async function ensureIncomeCategories(client) {
    for (const cat of INCOME_SAFE_CATEGORIES) {
        await ensureCategoryExists(client, cat, 'income', null, null);
    }
}

async function ensureExpenseCategories(client) {
    for (const cat of EXPENSE_SAFE_CATEGORIES) {
        await ensureCategoryExists(client, cat, 'expense', null, null);
    }
}

async function ensureCategoryAliasesTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS category_aliases (
            id SERIAL PRIMARY KEY,
            old_name VARCHAR(255) NOT NULL,
            old_name_norm VARCHAR(255) NOT NULL,
            target_name VARCHAR(255) NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);
    await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS category_aliases_old_name_norm_uq
            ON category_aliases (old_name_norm)
    `);
}

async function upsertCategoryAlias(client, oldName, targetName) {
    const oldRaw = String(oldName || '').trim();
    const targetRaw = String(targetName || '').trim();
    if (!oldRaw || !targetRaw) return;
    const oldNorm = normalizeCategoryName(oldRaw);
    const targetNorm = normalizeCategoryName(targetRaw);
    if (!oldNorm || oldNorm === targetNorm) return;
    await ensureCategoryAliasesTable(client);
    await client.query(
        `
        INSERT INTO category_aliases (old_name, old_name_norm, target_name, is_active, updated_at)
        VALUES ($1, $2, $3, true, NOW())
        ON CONFLICT (old_name_norm)
        DO UPDATE SET target_name = EXCLUDED.target_name, is_active = true, updated_at = NOW()
    `,
        [oldRaw, oldNorm, targetRaw]
    );
}

async function resolveCategoryAlias(client, categoryName) {
    const raw = String(categoryName || '').trim();
    if (!raw) return raw;
    const norm = normalizeCategoryName(raw);
    if (!norm) return raw;
    await ensureCategoryAliasesTable(client);
    const res = await client.query(
        `
        SELECT target_name
        FROM category_aliases
        WHERE old_name_norm = $1 AND is_active = true
        LIMIT 1
    `,
        [norm]
    );
    if (res.rows.length > 0 && res.rows[0].target_name) return String(res.rows[0].target_name).trim();
    return raw;
}

function resolveIncomeCategoryByContext({ category = '', description = '', paymentMethod = '' }) {
    const original = String(category || '').trim();
    if (!original) return INCOME_DEFAULT_CATEGORY;
    if (isBidirectionalSystemCategory(original)) return original;
    const n = normalizeCategoryName(original);
    const d = String(description || '').toLowerCase();
    const m = String(paymentMethod || '').toLowerCase();

    if (n.includes('займ') || n.includes('заем') || n.includes('кредит')) return 'Получение займов';
    if (n.includes('возврат')) return INCOME_REFUND_IMPREST_CATEGORY;
    if (n.includes('учред')) return 'Взнос учредителя';
    if (n === 'нераспределенное') {
        if (d.includes('зач') && d.includes('аван')) return 'Оплата по счету';
        return INCOME_DEFAULT_CATEGORY;
    }
    if (n === 'услуги банка и рко') return INCOME_REFUND_IMPREST_CATEGORY;
    if (n === 'закупка сырья') return INCOME_REFUND_IMPREST_CATEGORY;
    if (n === 'зарплата и авансы') return INCOME_REFUND_IMPREST_CATEGORY;
    if (n === 'оплата по счету') return 'Оплата по счету';
    if (n === 'продажа продукции') return 'Продажа продукции';
    if (n === 'прочие доходы') return INCOME_DEFAULT_CATEGORY;

    if (d.includes('зк-') || d.includes('сч-')) return 'Оплата по счету';
    if (d.includes('займ') || d.includes('заем') || d.includes('кредит')) return 'Получение займов';
    if (d.includes('возврат')) return INCOME_REFUND_IMPREST_CATEGORY;
    if (d.includes('учред')) return 'Взнос учредителя';
    if (m.includes('эквайринг') || m.includes('рко') || m.includes('комисс')) return INCOME_DEFAULT_CATEGORY;

    return original;
}

function resolveExpenseCategoryByContext({ category = '', description = '', paymentMethod = '' }) {
    const original = String(category || '').trim();
    if (!original) return 'Нераспределенное';
    if (isBidirectionalSystemCategory(original)) return original;
    const n = normalizeCategoryName(original);
    const d = String(description || '').toLowerCase();
    const m = String(paymentMethod || '').toLowerCase();

    if (n === 'зарплата') return 'Зарплата и Авансы';
    if (n === 'транспортные услуги') return 'Транспортные расходы';
    if (n.includes('транспорт')) return 'Транспортные расходы';
    if (n.includes('комисс') && n.includes('банк')) return 'Услуги банка и РКО';
    if (n.includes('рко') || n.includes('эквайр')) return 'Услуги банка и РКО';
    if (n.includes('налог') || n.includes('штраф') || n.includes('взнос')) return 'Налоги, штрафы и взносы';
    if (n.includes('зарплат') || n.includes('аванс')) return 'Зарплата и Авансы';
    if (n.includes('сыр') || n.includes('материал') || n.includes('закуп')) return 'Закупка сырья';
    if (n.includes('займ') || n.includes('заем') || n.includes('кредит')) return 'Возврат заемных средств';

    if (d.includes('зарплат') || d.includes('аванс')) return 'Зарплата и Авансы';
    if (d.includes('доставк') || d.includes('логист') || d.includes('транспорт')) return 'Транспортные расходы';
    if (d.includes('комисс') || m.includes('эквайр') || m.includes('рко')) return 'Услуги банка и РКО';
    if (d.includes('займ') || d.includes('заем') || d.includes('кредит')) return 'Возврат заемных средств';
    if (d.includes('налог') || d.includes('штраф') || d.includes('взнос')) return 'Налоги, штрафы и взносы';

    return original;
}

function resolveTechnicalOverrideByContext({
    category = '',
    description = '',
    paymentMethod = '',
    accountId = null,
    counterpartyId = null
}) {
    if (!isTechnicalWildCategory(category)) return null;
    const d = String(description || '').toLowerCase();
    const m = String(paymentMethod || '').toLowerCase();

    if (d.includes('ввод начальных остатков') || d.includes('начальн') && d.includes('остат')) {
        return TECHNICAL_CATEGORIES.OPENING;
    }
    if (m.includes('системная правка')) {
        return TECHNICAL_CATEGORIES.BALANCE_CORRECTION;
    }
    if (d.includes('коррект')) {
        return TECHNICAL_CATEGORIES.BALANCE_CORRECTION;
    }
    if (m.includes('взаимозач')) {
        return TECHNICAL_CATEGORIES.TECHNICAL;
    }
    if (accountId == null) {
        return TECHNICAL_CATEGORIES.BALANCE_CORRECTION;
    }
    return TECHNICAL_CATEGORIES.TECHNICAL;
}

/**
 * Удаление проводки, привязанной к плану: уменьшает amount_paid, статус paid только если остаток по-прежнему закрывает план.
 */
async function revertPlannedExpenseOnTxDelete(client, plannedId, txAmount) {
    const pRes = await client.query(
        'SELECT id, amount, COALESCE(amount_paid, 0) AS amount_paid FROM planned_expenses WHERE id = $1',
        [plannedId]
    );
    if (pRes.rows.length === 0) return;
    const p = pRes.rows[0];
    const total = new Big(String(p.amount));
    let newPaid = new Big(String(p.amount_paid)).minus(String(txAmount));
    if (newPaid.lt(0)) newPaid = new Big(0);
    const r = newPaid.round(2);
    const newStatus = r.cmp(total) >= 0 || total.minus(r).abs().lt(0.01) ? 'paid' : 'pending';
    await client.query('UPDATE planned_expenses SET amount_paid = $1::numeric, status = $2 WHERE id = $3', [
        r.toFixed(2),
        newStatus,
        plannedId
    ]);
}

module.exports = function (pool, upload, withTransaction, ERP_CONFIG) {
    async function recalcAccountBalances(client, accountIds = []) {
        const unique = Array.from(new Set((accountIds || []).map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0)));
        if (!unique.length) return;
        await client.query(
            `
            UPDATE accounts a
            SET balance = ROUND(COALESCE((
                SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) -
                       SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END)
                FROM transactions t
                WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
            ), 0), 2)
            WHERE a.id = ANY($1::int[])
        `,
            [unique]
        );
    }

    async function softDeleteTransactionWithRollback(client, txId) {
        const txRes = await client.query(
            `SELECT id, amount, transaction_type, linked_order_id, linked_planned_id, linked_id, account_id
             FROM transactions
             WHERE id = $1
               AND COALESCE(is_deleted, false) = false`,
            [txId]
        );
        if (txRes.rows.length === 0) return { found: false, affectedAccountIds: [] };
        const tx = txRes.rows[0];
        const affectedAccountIds = [];

        if (tx.linked_order_id && tx.transaction_type === 'income') {
            await client.query(
                `
                UPDATE client_orders
                SET paid_amount = GREATEST(COALESCE(paid_amount, 0) - $1, 0),
                    pending_debt = COALESCE(pending_debt, 0) + $1
                WHERE id = $2
            `,
                [tx.amount, tx.linked_order_id]
            );
            await reconcileOrderSettlement(client, Number(tx.linked_order_id), { apply: true, forUpdate: true });
        }

        if (tx.linked_planned_id) {
            await revertPlannedExpenseOnTxDelete(client, tx.linked_planned_id, tx.amount);
        }

        if (tx.linked_id) {
            const pairRes = await client.query(
                `SELECT id, account_id
                 FROM transactions
                 WHERE (id = $1 OR linked_id = $2)
                   AND COALESCE(is_deleted, false) = false`,
                [txId, tx.linked_id]
            );
            for (const row of pairRes.rows) {
                if (row.account_id) affectedAccountIds.push(Number(row.account_id));
            }
            await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1 OR linked_id = $2', [txId, tx.linked_id]);
        } else {
            await client.query('UPDATE transactions SET is_deleted = true WHERE id = $1', [txId]);
            if (tx.account_id) affectedAccountIds.push(Number(tx.account_id));
        }

        return { found: true, affectedAccountIds };
    }







    // ==========================================
        // ==========================================
    // 0. СПРАВОЧНИК КАТЕГОРИЙ (Single Source of Truth)
    // ==========================================
    router.get('/api/finance/categories', async (req, res) => {
        try {
            await ensureTransferCategories(pool);
            await ensureTechnicalCategories(pool);
            await ensureIncomeCategories(pool);
            await ensureExpenseCategories(pool);
            await ensureCategoryAliasesTable(pool);
            // Кэш 5 мин — категории меняются редко
            const rows = await cache.getOrSet('finance:categories', async () => {
                const result = await pool.query(`
                    SELECT id, name, type, cost_group, parent_id, is_archived, monthly_limit, false as is_wild
                    FROM transaction_categories
                    UNION
                    SELECT NULL as id, COALESCE(NULLIF(TRIM(category_override), ''), category) as name, MAX(transaction_type) as type, NULL as cost_group, NULL as parent_id, false as is_archived, 0 as monthly_limit, true as is_wild
                      FROM transactions
                     WHERE COALESCE(NULLIF(TRIM(category_override), ''), category) IS NOT NULL
                       AND COALESCE(NULLIF(TRIM(category_override), ''), category) != ''
                       AND (is_deleted IS NULL OR is_deleted = false)
                       AND LOWER(TRIM(COALESCE(NULLIF(TRIM(category_override), ''), category))) NOT IN (
                           SELECT LOWER(TRIM(tc.name))
                           FROM transaction_categories tc
                           WHERE tc.name IS NOT NULL AND TRIM(tc.name) != ''
                       )
                     GROUP BY COALESCE(NULLIF(TRIM(category_override), ''), category)
                    ORDER BY name
                `);
                return result.rows;
            }, 300000);
            res.json(rows);
        } catch (err) {
            logger.error('[API] Error in GET /api/finance/categories:', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    /**
     * Операции по статье ДДС: для строки справочника с id — все проводки по этой статье и подстатьям (дерево),
     * для «дикой» — только по точному совпадению текста категории (без учёта регистра и краевых пробелов).
     */
    router.get('/api/finance/category-transactions', async (req, res) => {
        const rawId = req.query.category_id;
        const name = (req.query.name || '').trim();
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 80, 1), 200);

        try {
            if (rawId != null && String(rawId).trim() !== '' && String(rawId) !== 'undefined') {
                const id = parseInt(rawId, 10);
                if (Number.isNaN(id)) {
                    return res.status(400).json({ error: 'Некорректный category_id' });
                }
                const cntRes = await pool.query(
                    `
                    WITH RECURSIVE subtree AS (
                        SELECT id, name FROM transaction_categories WHERE id = $1
                        UNION ALL
                        SELECT tc.id, tc.name FROM transaction_categories tc
                        INNER JOIN subtree s ON tc.parent_id = s.id
                    ),
                    keys AS (SELECT DISTINCT LOWER(TRIM(name)) AS k FROM subtree WHERE TRIM(name) != '')
                    SELECT COUNT(*)::int AS cnt FROM transactions t
                    WHERE COALESCE(t.is_deleted, false) = false
                      AND LOWER(TRIM(COALESCE(NULLIF(TRIM(t.category_override), ''), t.category))) IN (SELECT k FROM keys)
                `,
                    [id]
                );
                const rowsRes = await pool.query(
                    `
                    WITH RECURSIVE subtree AS (
                        SELECT id, name FROM transaction_categories WHERE id = $1
                        UNION ALL
                        SELECT tc.id, tc.name FROM transaction_categories tc
                        INNER JOIN subtree s ON tc.parent_id = s.id
                    ),
                    keys AS (SELECT DISTINCT LOWER(TRIM(name)) AS k FROM subtree WHERE TRIM(name) != '')
                    SELECT t.id,
                           t.transaction_date,
                           t.amount::text,
                           t.transaction_type,
                           t.category,
                           LEFT(COALESCE(t.description, ''), 200) AS description
                    FROM transactions t
                    WHERE COALESCE(t.is_deleted, false) = false
                      AND LOWER(TRIM(COALESCE(NULLIF(TRIM(t.category_override), ''), t.category))) IN (SELECT k FROM keys)
                    ORDER BY t.transaction_date DESC NULLS LAST, t.id DESC
                    LIMIT $2
                `,
                    [id, limit]
                );
                return res.json({ count: cntRes.rows[0].cnt, transactions: rowsRes.rows });
            }

            if (!name) {
                return res.status(400).json({ error: 'Укажите category_id или name' });
            }

            const cntRes = await pool.query(
                `
                SELECT COUNT(*)::int AS cnt FROM transactions t
                WHERE COALESCE(t.is_deleted, false) = false
                  AND LOWER(TRIM(COALESCE(NULLIF(TRIM(t.category_override), ''), t.category))) = LOWER(TRIM($1::text))
            `,
                [name]
            );
            const rowsRes = await pool.query(
                `
                SELECT t.id,
                       t.transaction_date,
                       t.amount::text,
                       t.transaction_type,
                       t.category,
                       LEFT(COALESCE(t.description, ''), 200) AS description
                FROM transactions t
                WHERE COALESCE(t.is_deleted, false) = false
                  AND LOWER(TRIM(COALESCE(NULLIF(TRIM(t.category_override), ''), t.category))) = LOWER(TRIM($1::text))
                ORDER BY t.transaction_date DESC NULLS LAST, t.id DESC
                LIMIT $2
            `,
                [name, limit]
            );
            return res.json({ count: cntRes.rows[0].cnt, transactions: rowsRes.rows });
        } catch (err) {
            logger.error('[API] Error in GET /api/finance/category-transactions:', err);
            res.status(500).json({ error: 'Ошибка загрузки операций по статье' });
        }
    });

    // Добавление новой категории
    router.post('/api/finance/category-full', requireAdmin, async (req, res) => {
        try {
            const { name, type, cost_group, parent_id, monthly_limit } = req.body;
            const safeType = type === 'income' ? 'income' : 'expense';
            const safeCostGroup = safeType === 'expense' ? ensureCanonicalCostGroup(cost_group, 'opex') : null;
            await pool.query(
                'INSERT INTO transaction_categories (name, type, cost_group, parent_id, monthly_limit) VALUES ($1, $2, $3, $4, $5)', 
                [name, safeType, safeCostGroup, parent_id || null, monthly_limit || 0]
            );
            await auditLog(pool, req, 'finance_category_create', 'transaction_category', null, `Создана категория: ${name}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Обновление категории (редактирование)
    router.put('/api/finance/category-full/:id', requireAdmin, async (req, res) => {
        try {
            const { name, type, cost_group, parent_id, monthly_limit } = req.body;
            const safeType = type === 'income' ? 'income' : 'expense';
            const safeCostGroup = safeType === 'expense' ? ensureCanonicalCostGroup(cost_group, 'opex') : null;

            const oldName = await withTransaction(pool, async (client) => {
                const oldCatRes = await client.query('SELECT name FROM transaction_categories WHERE id = $1', [req.params.id]);
                if (oldCatRes.rows.length === 0) throw new Error('Category not found');
                const prevName = oldCatRes.rows[0].name;

                await client.query(
                    'UPDATE transaction_categories SET name=$1, type=$2, cost_group=$3, parent_id=$4, monthly_limit=$5 WHERE id=$6', 
                    [name, safeType, safeCostGroup, parent_id || null, monthly_limit || 0, req.params.id]
                );

                // Если переименовали, обновляем все исторические транзакции (чтобы не отвязались)
                if (prevName !== name) {
                    await client.query('UPDATE transactions SET category = $1 WHERE category = $2', [name, prevName]);
                }
                return prevName;
            });
            await auditLog(pool, req, 'finance_category_update', 'transaction_category', Number(req.params.id), `Обновлена категория: ${oldName} -> ${name}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Архивация или Разархивация
    router.put('/api/finance/category-full/:id/archive', requireAdmin, async (req, res) => {
        try {
            const { is_archived } = req.body;
            const reason = String((req.body || {}).reason || '').trim();
            if (!reason) return res.status(400).json({ error: 'Укажите причину изменения статуса' });
            await pool.query('UPDATE transaction_categories SET is_archived = $1 WHERE id = $2', [is_archived, req.params.id]);
            await auditLog(pool, req, 'finance_category_archive', 'transaction_category', Number(req.params.id), `is_archived=${Boolean(is_archived)}; reason=${reason}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Smart Merge (Умное объединение дубликатов)
    // Принимает source_names (массив имен, т.к. "дикие" транзакции привязаны по имени) 
    // и target_name (имя категории в которую объединяем)
    router.post('/api/finance/category-merge', requireAdmin, async (req, res) => {
        try {
            const sourceNames = sanitizeNameArray((req.body || {}).source_names, { max: 200 });
            const targetName = String((req.body || {}).target_name || '').trim();
            const reason = String((req.body || {}).reason || '').trim();
            if (!targetName || !sourceNames || sourceNames.length === 0) {
                return res.status(400).json({ error: 'Не переданы данные для объединения' });
            }
            if (!reason) return res.status(400).json({ error: 'Укажите причину слияния' });
            if (sourceNames.some((n) => n.toLowerCase() === targetName.toLowerCase())) {
                return res.status(400).json({ error: 'Целевая категория не должна входить в список source_names' });
            }

            await withTransaction(pool, async (client) => {
                const targetExists = await client.query('SELECT id FROM transaction_categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1::text)) LIMIT 1', [targetName]);
                if (!targetExists.rows.length) {
                    const err = new Error('Целевая категория не найдена в справочнике');
                    err.statusCode = 400;
                    throw err;
                }

                await client.query(
                    'UPDATE transactions SET category = $2 WHERE category = ANY($1::varchar[])',
                    [sourceNames, targetName]
                );
                await client.query(
                    'UPDATE transactions SET category_override = $2 WHERE category_override = ANY($1::varchar[])',
                    [sourceNames, targetName]
                );

                await client.query(
                    'DELETE FROM transaction_categories WHERE name = ANY($1::varchar[]) AND name != $2',
                    [sourceNames, targetName]
                );

                for (const sourceName of sourceNames) {
                    await upsertCategoryAlias(client, sourceName, targetName);
                }
            });
            await auditLog(pool, req, 'finance_category_merge', 'transaction_category', null, `Merge категорий [${sourceNames.join(', ')}] -> ${targetName}; reason=${reason}`);
            res.json({ success: true });
        } catch (err) {
            if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка.' });
        }
    });

    // ==========================================
    // ==========================================
    // 1. ОТЧЕТ P&L (ДИНАМИЧЕСКИЙ МЕТОД СО СРЕДНЕВЗВЕШЕННОЙ COGS И ТАБЕЛЯМИ)
    // ==========================================
    
    // ==========================================
    // СИНХРОНИЗАЦИЯ ОБЕЗЛИЧЕННЫХ ТРАНЗАКЦИЙ (Орфанов)
    // ==========================================
    router.get('/api/finance/orphans', requireAdmin, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT t.id, t.transaction_date, t.amount, t.transaction_type, t.category, t.description 
                FROM transactions t
                WHERE t.counterparty_id IS NULL AND (t.is_deleted = false OR t.is_deleted IS NULL)
                ORDER BY t.transaction_date DESC, t.id DESC
            `);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка при загрузке несинхронизированных транзакций.' });
        }
    });

    router.post('/api/finance/bind-orphan', requireAdmin, async (req, res) => {
        try {
            const { transaction_id, counterparty_id } = req.body;
            if (!transaction_id || !counterparty_id) {
                return res.status(400).json({ error: 'ID транзакции и Контрагента обязательны.' });
            }
            await pool.query('UPDATE transactions SET counterparty_id = $1 WHERE id = $2', [counterparty_id, transaction_id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Возникла ошибка при привязке контрагента.' });
        }
    });

    router.get('/api/finance/pnl', async (req, res) => {
        let { start, end } = req.query;

        if (!start || !end || start === '' || end === '') {
            start = '2024-01-01';
            end = new Date().toISOString().split('T')[0];
        }

        try {
            const effectiveGroupSql = getEffectiveCostGroupSql('t', 'tc', 'tc_override', 'opex');
            const transferPredicate = getTransferCategoryPredicateSql('t');
            const effectiveCatSql = `COALESCE(NULLIF(TRIM(t.category_override), ''), t.category)`;

            // 🚀 EPIC-4 P2: 6 запросов → 2 (1 CTE для transactions + 1 для timesheet)
            const [txRes, laborRes] = await Promise.all([
                // Единый запрос: все компоненты P&L за один проход по transactions
                pool.query(`
                    WITH tx AS (
                        SELECT
                            t.amount,
                            t.transaction_type,
                            ${effectiveCatSql} as effective_cat,
                            (${effectiveGroupSql}) as effective_group,
                            (${transferPredicate}) as is_transfer
                        FROM transactions t
                        LEFT JOIN transaction_categories tc ON t.category = tc.name
                        LEFT JOIN transaction_categories tc_override ON t.category_override = tc_override.name
                        WHERE (t.is_deleted IS NULL OR t.is_deleted = false)
                          AND t.transaction_date >= $1::timestamp AND t.transaction_date < ($2::timestamp + interval '1 day')
                    )
                    SELECT
                        COALESCE(SUM(CASE WHEN transaction_type = 'income' AND effective_cat = 'Продажа продукции' THEN amount ELSE 0 END), 0) as revenue,
                        COALESCE(SUM(CASE WHEN transaction_type = 'income' AND effective_cat != 'Продажа продукции' THEN amount ELSE 0 END), 0) as other_income,
                        COALESCE(SUM(CASE WHEN transaction_type = 'expense' AND NOT is_transfer AND effective_group = 'direct' THEN amount ELSE 0 END), 0) as cogs,
                        COALESCE(SUM(CASE WHEN transaction_type = 'expense' AND NOT is_transfer AND effective_group = 'opex' THEN amount ELSE 0 END), 0) as opex,
                        COALESCE(SUM(CASE WHEN transaction_type = 'expense' AND NOT is_transfer AND effective_group NOT IN ('direct', 'opex') THEN amount ELSE 0 END), 0) as capex
                    FROM tx
                `, [start, end]),

                // ФОТ (отдельная таблица — нельзя объединить с transactions)
                pool.query(`
                    SELECT COALESCE(SUM(
                        COALESCE(bonus, 0) + COALESCE(custom_rate, 0) - COALESCE(penalty, 0)
                    ), 0) as total
                    FROM timesheet_records
                    WHERE record_date >= $1::timestamp AND record_date < ($2::timestamp + interval '1 day')
                `, [start, end])
            ]);

            // 🧮 МАТЕМАТИКА P&L (Big.js для точности до копеек)
            const r = txRes.rows[0];
            const revenue = new Big(Number(r.revenue));
            const otherIncome = new Big(Number(r.other_income));

            const cogs = new Big(Number(r.cogs));
            const opex = new Big(Number(r.opex));
            const capex = new Big(Number(r.capex));
            const labor = new Big(Number(laborRes.rows[0].total)).abs();

            const totalExpenses = cogs.plus(opex).plus(capex);
            const netProfit = revenue.minus(totalExpenses);
            const totalIncome = revenue;
            const margin = revenue.gt(0) && netProfit.gt(0)
                ? netProfit.div(revenue).times(100).toFixed(1)
                : "0.0";

            logger.info(`P&L API -> revenue: ${revenue.toString()} cogs: ${cogs.toString()} opex: ${opex.toString()} capex: ${capex.toString()} netProfit: ${netProfit.toString()}`);

            res.json({
                revenue: revenue.toFixed(2),
                otherIncome: otherIncome.toFixed(2),
                totalIncome: totalIncome.toFixed(2),

                cogs: cogs.toFixed(2),
                opex: opex.toFixed(2),
                capex: capex.toFixed(2),
                laborCosts: labor.toFixed(2),  // 📋 Справочно для руководителя
                totalExpenses: totalExpenses.toFixed(2),

                netProfit: netProfit.toFixed(2),
                margin: margin
            });

        } catch (err) {
            logger.error('КРИТИЧЕСКАЯ ОШИБКА P&L:', err.message, err.stack);
            res.status(500).json({ error: "Внутренняя ошибка сервера. Обратитесь к администратору." });
        }
    });

    // ==========================================
    // 2. ПЛАТЕЖНЫЙ КАЛЕНДАРЬ (ПЛАНОВЫЕ РАСХОДЫ)
    // ==========================================
    router.get('/api/finance/planned-expenses', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT id,
                    TO_CHAR(date, 'DD.MM.YYYY') AS date,
                    TO_CHAR(date, 'YYYY-MM-DD') AS date_iso,
                    TO_CHAR(date, 'IYYY-IW') AS week_id,
                    category, description, is_recurring,
                    amount::text,
                    COALESCE(amount_paid, 0)::text AS amount_paid,
                    (amount - COALESCE(amount_paid, 0))::text AS amount_remaining
                FROM planned_expenses
                WHERE status = 'pending'
                ORDER BY date ASC, id ASC
            `);
            res.json(result.rows);
        } catch (err) {
            logger.error('Ошибка загрузки календаря:', err.message);
            res.json([]);
        }
    });

    /** Создать плановый исходящий платёж (напоминание + будущая оплата из календаря) */
    router.post('/api/finance/planned-expenses', requirePlannedPlanManage, validatePlannedExpense, async (req, res) => {
        const { date, amount, category, description, is_recurring } = req.body;
        const amt = Number(new Big(String(amount).replace(/\s/g, '').replace(',', '.')).round(2));
        const desc = (description && String(description).trim()) || null;
        const rec = Boolean(is_recurring);
        const cat = String(category).trim();

        try {
            const ins = await pool.query(
                `INSERT INTO planned_expenses (date, amount, amount_paid, category, description, is_recurring, status)
                 VALUES ($1::date, $2, 0, $3, $4, $5, 'pending')
                 RETURNING id`,
                [date, amt, cat, desc, rec]
            );
            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            res.json({ success: true, id: ins.rows[0].id });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Не удалось сохранить план. Проверьте дату и форму.' });
        }
    });

    /** Удалить план без проведённых списаний (отмена обязательства) */
    router.delete('/api/finance/planned-expenses/:id', requirePlannedPlanManage, async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Некорректный ID' });

        try {
            const del = await pool.query(
                `DELETE FROM planned_expenses
                 WHERE id = $1 AND status = 'pending' AND COALESCE(amount_paid, 0) = 0
                 RETURNING id`,
                [id]
            );
            if (del.rowCount === 0) {
                return res.status(400).json({
                    error: 'План не найден, уже закрыт или по нему есть проводки. Удалите/отмените проводки в журнале, затем повторите.'
                });
            }
            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    router.post('/api/finance/planned-expenses/:id/pay', validatePlannedPay, async (req, res) => {
        const { account_id } = req.body;
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Некорректный ID' });

        try {
            await withTransaction(pool, async (client) => {
                const expRes = await client.query(
                    "SELECT * FROM planned_expenses WHERE id = $1 AND status = 'pending' FOR UPDATE",
                    [id]
                );
                if (expRes.rows.length === 0) throw new Error('Плановый платёж не найден или уже полностью закрыт');
                const exp = expRes.rows[0];

                const total = new Big(String(exp.amount));
                const paid = new Big(String(exp.amount_paid != null ? exp.amount_paid : 0));
                if (parseFloat(String(exp.amount)) <= 0) throw new Error('Сумма по плану должна быть больше нуля');
                const remaining = total.minus(paid);
                if (remaining.lte(0)) throw new Error('По плану нет остатка к списанию');

                let payAmount;
                if (req.body.amount != null && String(req.body.amount).trim() !== '') {
                    payAmount = new Big(String(req.body.amount).replace(/\s/g, '').replace(',', '.')).round(2);
                } else {
                    payAmount = remaining;
                }
                if (payAmount.lte(0)) throw new Error('Сумма списания должна быть больше нуля');
                if (payAmount.gt(remaining)) {
                    throw new Error(`Сумма не больше остатка по плану: ${remaining.toFixed(2)} ₽`);
                }

                const newPaid = paid.plus(payAmount).round(2);
                const fullyClosed = newPaid.cmp(total) >= 0 || total.minus(newPaid).abs().lt(0.01);
                const desc = fullyClosed
                    ? `Оплата плана: ${exp.category} (${exp.description || ''})`
                    : `Оплата плана (часть): ${exp.category} (${exp.description || ''})`;
                const payAt = exp.date ? new Date(exp.date) : new Date();

                await client.query(
                    `INSERT INTO transactions (account_id, amount, transaction_type, category, description, transaction_date, payment_method, source_module, linked_planned_id)
                    VALUES ($1, $2, 'expense', $3, $4, $5, $6, $7, $8)`,
                    [account_id, payAmount.toFixed(2), exp.category, desc, payAt, 'Безналичный расчет', 'finance', id]
                );

                if (fullyClosed) {
                    await client.query(
                        'UPDATE planned_expenses SET status = $1, amount_paid = $2 WHERE id = $3',
                        ['paid', total.toFixed(2), id]
                    );
                    if (exp.is_recurring) {
                        const nextDate = new Date(exp.date);
                        nextDate.setMonth(nextDate.getMonth() + 1);
                        await client.query(
                            'INSERT INTO planned_expenses (date, amount, amount_paid, category, description, is_recurring, status) VALUES ($1, $2, 0, $3, $4, $5, $6)',
                            [nextDate, exp.amount, exp.category, exp.description, true, 'pending']
                        );
                    }
                } else {
                    await client.query('UPDATE planned_expenses SET amount_paid = $1 WHERE id = $2', [newPaid.toFixed(2), id]);
                }
            });
            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            res.json({ success: true, message: 'Платёж успешно проведён' });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==========================================
    // 3. ТРАНЗАКЦИИ: СПИСОК И МАССОВОЕ УДАЛЕНИЕ
    // ==========================================
    router.get('/api/transactions', async (req, res) => {
        // 1. ДОБАВИЛИ type СЮДА 👇
        const { search, start, end, account_id, page, limit, type } = req.query;

        const parsedPage = parseInt(page) || 1;
        const parsedLimit = parseInt(limit) || 20;
        const offset = Math.max((parsedPage - 1) * parsedLimit, 0);

        try {
            let conditions = [
                "COALESCE(t.is_deleted, false) = false"
            ];
            let params = [];
            let paramIndex = 1;

            if (account_id && account_id !== 'null' && account_id !== 'undefined') {
                conditions.push(`t.account_id = $${paramIndex}`);
                params.push(parseInt(account_id));
                paramIndex++;
            }

            // 2. ДОБАВИЛИ ФИЛЬТР ПО ТИПУ (ДОХОД/РАСХОД) СЮДА 👇
            if (type && type !== 'all') {
                conditions.push(`t.transaction_type = $${paramIndex}`);
                params.push(type);
                paramIndex++;
            }

            if (search && String(search).trim() !== '') {
                conditions.push(`(t.description ILIKE $${paramIndex} OR COALESCE(t.category_override, t.category) ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex})`);
                params.push(`%${String(search).trim()}%`);
                paramIndex++;
            }

            if (start && end) {
                conditions.push(`t.transaction_date::date >= $${paramIndex}::date AND t.transaction_date::date <= $${paramIndex + 1}::date`);
                params.push(start, end);
                paramIndex += 2;
            }

            const whereClause = `WHERE ${conditions.join(' AND ')}`;

            const countRes = await pool.query(`SELECT COUNT(*) FROM transactions t LEFT JOIN counterparties c ON t.counterparty_id = c.id ${whereClause}`, params);
            const totalRecords = parseInt(countRes.rows[0].count);

            const dataQuery = `
                SELECT DISTINCT ON (t.transaction_date, t.id) t.id, t.transaction_date, t.amount, t.transaction_type, 
                       COALESCE(t.category_override, t.category) AS category, t.description, t.payment_method, t.vat_amount,
                       t.counterparty_id, t.account_id, 
                       t.cost_group_override, /* 👈 Добавили ручное исключение */
                       ${getEffectiveCostGroupSql('t', 'tc', 'tc_override', 'opex')} as current_cost_group,
                       c.name as counterparty_name, a.name as account_name
                FROM transactions t
                LEFT JOIN counterparties c ON t.counterparty_id = c.id
                LEFT JOIN accounts a ON t.account_id = a.id
                LEFT JOIN transaction_categories tc ON t.category = tc.name /* 👈 Джойним матрицу категорий */
                LEFT JOIN transaction_categories tc_override ON t.category_override = tc_override.name
                ${whereClause} 
                ORDER BY t.transaction_date DESC, t.id DESC 
                LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
            `;
            const dataParams = [...params, parsedLimit, offset];
            const dataRes = await pool.query(dataQuery, dataParams);

            res.json({
                data: dataRes.rows,
                pagination: {
                    total: totalRecords,
                    page: parsedPage,
                    limit: parsedLimit,
                    totalPages: Math.ceil(totalRecords / parsedLimit) || 1
                }
            });
        } catch (err) {
            logger.error('Ошибка загрузки транзакций:', err);
            res.status(500).json({ error: 'Ошибка сервера при загрузке данных' });
        }
    });

    router.delete('/api/transactions/bulk-delete', requireAdmin, async (req, res) => {
        const ids = sanitizeIdArray((req.body || {}).ids, { max: 1000 });
        const reason = String((req.body || {}).reason || '').trim();
        if (!ids || ids.length === 0) return res.json({ success: true });
        if (!reason) return res.status(400).json({ error: 'Укажите причину массового удаления' });

        try {
            await withTransaction(pool, async (client) => {
                const touchedAccounts = [];
                for (let id of ids) {
                    const out = await softDeleteTransactionWithRollback(client, id);
                    if (out.found && out.affectedAccountIds.length) {
                        touchedAccounts.push(...out.affectedAccountIds);
                    }
                }
                await recalcAccountBalances(client, touchedAccounts);
            });

            // Аудит: запись о массовом удалении
            for (const id of ids) {
                await auditLog(pool, req, 'delete_transaction', 'transaction', id, `Массовое удаление (bulk-delete); reason=${reason}`);
            }
            await auditLog(pool, req, 'finance_bulk_delete', 'transaction', null, `count=${ids.length}; reason=${reason}`);

            res.json({ success: true });
        } catch (e) {
            logger.error(e);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ==========================================
    // 4. КАТЕГОРИИ ТРАНЗАКЦИЙ (СПРАВОЧНИК)
    // ==========================================

    router.post('/api/finance/categories', requireAdmin, validateCategory, async (req, res) => {
        try {
            await pool.query('INSERT INTO transaction_categories (name, type) VALUES ($1, $2)', [req.body.name, req.body.type]);
            cache.invalidate('finance:categories');
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.delete('/api/finance/categories/:id', requireAdmin, async (req, res) => {
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления категории' });
        try {
            await pool.query('DELETE FROM transaction_categories WHERE id = $1', [req.params.id]);
            cache.invalidate('finance:categories');
            await auditLog(pool, req, 'finance_category_delete', 'transaction_category', Number(req.params.id), `reason=${reason}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Обновление группы затрат (Матрица статей)
    router.put('/api/finance/categories/:id/group', requireAdmin, validateCostGroup, async (req, res) => {
        try {
            const { cost_group } = req.body;
            const safeGroup = ensureCanonicalCostGroup(cost_group, 'opex');
            await pool.query('UPDATE transaction_categories SET cost_group = $1 WHERE id = $2', [safeGroup, req.params.id]);
            cache.invalidate('finance:categories');
            await auditLog(pool, req, 'finance_category_group_update', 'transaction_category', Number(req.params.id), `Смена группы категории -> ${safeGroup}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // Получение группы затрат для предпросмотра категории (с учётом transaction_rules для контрагента)
    router.get('/api/finance/category-info', async (req, res) => {
        const { name, counterparty_id: cpRaw } = req.query;
        const empty = () => res.json({ cost_group: null, source: null });
        if (!name) return empty();

        try {
            await ensureCategoryAliasesTable(pool);
            const n = (name || '').trim();
            if (!n) return empty();

            const cpId = parseInt(cpRaw, 10);
            const hasCp = Number.isInteger(cpId) && cpId > 0;

            let aliasCanon = null;
            const aliasRes = await pool.query(
                `SELECT target_name FROM category_aliases WHERE old_name_norm = LOWER(TRIM($1::text)) AND is_active = true LIMIT 1`,
                [n]
            );
            if (aliasRes.rows.length > 0 && aliasRes.rows[0].target_name) {
                aliasCanon = String(aliasRes.rows[0].target_name || '').trim() || null;
            }

            if (hasCp) {
                const trRes = await pool.query(
                    `
                    SELECT target_cost_group FROM transaction_rules
                    WHERE counterparty_id = $1
                      AND (
                        target_category = $2
                        OR LOWER(TRIM(target_category)) = LOWER(TRIM($2::text))
                        OR ($3::text IS NOT NULL AND (
                             target_category = $3
                             OR LOWER(TRIM(target_category)) = LOWER(TRIM($3::text))
                        ))
                      )
                    LIMIT 1
                    `,
                    [cpId, n, aliasCanon]
                );
                if (trRes.rows.length > 0) {
                    const tcg = trRes.rows[0].target_cost_group;
                    if (tcg != null && String(tcg).trim() !== '') {
                        const cgRule = ensureCanonicalCostGroup(String(tcg).trim(), null);
                        if (cgRule && CANONICAL_COST_GROUPS.includes(cgRule)) {
                            return res.json({ cost_group: cgRule, source: 'rule' });
                        }
                    }
                }
            }

            // Приоритет: dashboard_rules (точное совпадение, затем без учёта регистра)
            const ruleRes = await pool.query(
                `SELECT mapped_cost_group FROM dashboard_rules
                 WHERE original_category = $1 OR mapped_category = $1
                    OR LOWER(TRIM(original_category)) = LOWER($2) OR LOWER(TRIM(mapped_category)) = LOWER($2)
                 LIMIT 1`,
                [n, n]
            );
            if (ruleRes.rows.length > 0 && ruleRes.rows[0].mapped_cost_group) {
                const cg = ensureCanonicalCostGroup(ruleRes.rows[0].mapped_cost_group, null);
                return res.json({ cost_group: cg, source: 'dashboard_rule' });
            }

            const catRes = await pool.query(
                `SELECT cost_group FROM transaction_categories
                 WHERE name = $1 OR LOWER(TRIM(name)) = LOWER($2::text) LIMIT 1`,
                [n, n]
            );
            if (catRes.rows.length > 0 && catRes.rows[0].cost_group) {
                const cg = ensureCanonicalCostGroup(catRes.rows[0].cost_group, null);
                return res.json({ cost_group: cg, source: 'category' });
            }

            return empty();
        } catch (err) {
            logger.error('[category-info]', err);
            return empty();
        }
    });

    // ==========================================
    // 5. КОНТРАГЕНТЫ (CRM) И КАРТОЧКА 360°
    // ==========================================
    router.get('/api/counterparties', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT c.id, c.name, 
                       COALESCE(c.phone, '') as phone, COALESCE(c.email, '') as email,
                       COALESCE(c.inn, '') as inn, COALESCE(c.kpp, '') as kpp,
                       COALESCE(c.ogrn, '') as ogrn, COALESCE(c.legal_address, '') as legal_address,
                       COALESCE(c.fact_address, '') as fact_address,
                       COALESCE(c.bank_name, '') as bank_name, COALESCE(c.bank_bik, '') as bank_bik,
                       COALESCE(c.bank_account, '') as bank_account, COALESCE(c.bank_corr, '') as bank_corr,
                       COALESCE(c.checking_account, '') as checking_account, COALESCE(c.bik, '') as bik,
                       COALESCE(c.director_name, '') as director_name,
                       COALESCE(c.comment, '') as comment,
                       COALESCE(c.client_category, 'Обычный') as client_category,
                       COALESCE(c.entity_type, 'legal') as entity_type,
                       COALESCE(c.is_buyer, false) as is_buyer,
                       COALESCE(c.is_supplier, false) as is_supplier,
                       COALESCE(c.is_employee, false) as is_employee,
                       c.employee_id, c.pallets_balance, c.price_level, c.role,
                       COALESCE(SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END), 0) as total_paid_to_us,
                       COALESCE(SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END), 0) as total_paid_by_us,
                       MAX(t.transaction_date) as last_transaction_date
                FROM counterparties c
                LEFT JOIN transactions t ON c.id = t.counterparty_id AND COALESCE(t.is_deleted, false) = false
                WHERE COALESCE(c.is_deleted, false) = false
                GROUP BY c.id
                ORDER BY last_transaction_date DESC NULLS LAST, c.name ASC
            `);
            res.json(result.rows);
        } catch (err) {
            logger.error('Ошибка в списке контрагентов:', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/counterparties/:id/full', async (req, res) => {
        const cpId = req.params.id;
        try {
            const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cpId]);
            if (cpRes.rows.length === 0) return res.status(404).json({ error: 'Не найден' });

            const finRes = await pool.query(`
                SELECT 
                    COALESCE(SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END), 0) as total_paid_to_us,
                    COALESCE(SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END), 0) as total_paid_to_them
                FROM transactions 
                WHERE counterparty_id = $1 AND COALESCE(is_deleted, false) = false 
                  AND category NOT IN ('Зачёт аванса', 'Взаимозачет') 
                  AND (COALESCE(payment_method, '') != 'Взаимозачет' OR category IN ('Начисление ЗП', 'Зарплата', 'Оплата труда', 'Зарплата и Авансы', 'Премии', 'Штрафы', 'Удержание из ЗП', 'Ввод начальных остатков'))
            `, [cpId]);

            const finances = finRes.rows[0];
            const balance = new Big(finances.total_paid_to_us).minus(finances.total_paid_to_them).toFixed(2);

            res.json({ cp: cpRes.rows[0], finances: { ...finances, balance } });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/counterparties/:id/profile', async (req, res) => {
        const cpId = req.params.id;
        if (!cpId || cpId === 'null') return res.status(400).json({ error: 'ID не указан' });

        try {
            const cpRes = await pool.query('SELECT * FROM counterparties WHERE id = $1', [cpId]);
            if (cpRes.rows.length === 0) return res.status(404).json({ error: 'Контрагент не найден' });
            const cp = cpRes.rows[0];

            const queries = `
                SELECT amount::numeric, transaction_type, category, description,
                       TO_CHAR(transaction_date, 'DD.MM.YYYY HH24:MI') as date, 'money' as origin, transaction_date as sort_date
                FROM transactions WHERE counterparty_id = $1 AND COALESCE(is_deleted, false) = false 
                  AND category NOT IN ('Зачёт аванса', 'Взаимозачет') 
                  AND (COALESCE(payment_method, '') != 'Взаимозачет' OR category IN ('Начисление ЗП', 'Зарплата', 'Оплата труда', 'Зарплата и Авансы', 'Премии', 'Штрафы', 'Удержание из ЗП', 'Ввод начальных остатков'))
                UNION ALL
                SELECT SUM(ABS(m.quantity) * coi.price)::numeric as amount, 'expense' as transaction_type, 'Отгрузка продукции' as category,
                       m.description as description, TO_CHAR(COALESCE(m.movement_date, m.created_at), 'DD.MM.YYYY') as date, 'goods' as origin, COALESCE(m.movement_date, m.created_at) as sort_date
                FROM inventory_movements m
                JOIN client_order_items coi ON m.linked_order_item_id = coi.id
                JOIN client_orders co ON coi.order_id = co.id
                WHERE co.counterparty_id = $1 AND m.movement_type = 'sales_shipment'
                GROUP BY m.description, COALESCE(m.movement_date, m.created_at)
                UNION ALL
                SELECT amount::numeric, 'income' as transaction_type, 'Поставка сырья' as category,
                       description, TO_CHAR(COALESCE(movement_date, created_at), 'DD.MM.YYYY') as date, 'goods' as origin, COALESCE(movement_date, created_at) as sort_date
                FROM inventory_movements WHERE supplier_id = $1 AND movement_type = 'purchase'
            `;
            const timelineRes = await pool.query(`SELECT * FROM (${queries}) AS combined ORDER BY sort_date DESC`, [cpId]);
            const timeline = timelineRes.rows;

            // УНИВЕРСАЛЬНАЯ ФОРМУЛА САЛЬДО ERP:
            let ourShipments = new Big(0); let ourPayments = new Big(0);
            let theirShipments = new Big(0); let theirPayments = new Big(0);

            timeline.forEach(item => {
                const amt = new Big(item.amount);
                if (item.origin === 'goods') {
                    if (item.transaction_type === 'expense') ourShipments = ourShipments.plus(amt);
                    else theirShipments = theirShipments.plus(amt);
                } else if (item.origin === 'money') {
                    if (item.transaction_type === 'expense') ourPayments = ourPayments.plus(amt);
                    else theirPayments = theirPayments.plus(amt);
                }
            });

            // Положительное сальдо: должны НАМ. Отрицательное: должны МЫ.
            const balance = ourShipments.plus(ourPayments).minus(theirShipments).minus(theirPayments).toFixed(2);

            const balanceBig = new Big(balance);
            const overpayment = balanceBig.lt(0) ? balanceBig.abs().toFixed(2) : '0.00';
            res.json({
                info: cp,
                transactions: timeline,
                finances: { balance, totalPaid: theirPayments.toFixed(2), totalInvoiced: ourShipments.toFixed(2) },
                overpayment: Number(overpayment),
                saldo: Number(balance),
                invoices: [], contracts: []
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/counterparties/:id/contracts', async (req, res) => {
        const cpId = req.params.id;
        if (!cpId || cpId === 'null' || cpId === 'undefined') return res.json([]);

        try {
            const result = await pool.query(`
                SELECT 
                    c.id as contract_id, c.number as contract_number, TO_CHAR(c.date, 'DD.MM.YYYY') as contract_date,
                    s.id as spec_id, s.number as spec_number, TO_CHAR(s.date, 'DD.MM.YYYY') as spec_date
                FROM contracts c
                LEFT JOIN specifications s ON c.id = s.contract_id
                WHERE c.counterparty_id = $1
                ORDER BY c.date DESC, s.date DESC
            `, [cpId]);
            res.json(result.rows);
        } catch (err) {
            logger.error('Ошибка загрузки договоров:', err.message);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/counterparties', requireAdmin, validateCounterparty, async (req, res) => {
        // 🚀 ИСПРАВЛЕНИЕ: Добавили price_level и type
        const { name, role, type, price_level, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, entity_type, is_buyer, is_supplier } = req.body;
        try {
            // Фронтенд продаж шлет type, а старые формы шлют role
            const finalRole = type || role || 'Покупатель';
            let buyer = is_buyer !== undefined ? is_buyer : (finalRole === 'Покупатель' || !finalRole);
            let supplier = is_supplier !== undefined ? is_supplier : (finalRole === 'Поставщик');
            const etRaw = String(entity_type || '').trim().toLowerCase();
            const entityTypeNorm = etRaw === 'physical' ? 'physical' : 'legal';

            await pool.query(`
                INSERT INTO counterparties (name, role, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, entity_type, is_buyer, is_supplier, price_level) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            `, [name, finalRole, client_category || 'Обычный', inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, entityTypeNorm, buyer, supplier, price_level || 'basic']);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.put('/api/counterparties/:id', requireAdmin, validateCounterparty, async (req, res) => {
        // 🚀 ИСПРАВЛЕНИЕ: Добавили price_level и type
        const { name, role, type, price_level, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, entity_type, is_buyer, is_supplier } = req.body;
        try {
            const finalRole = type || role; // Берем то, что прислал фронтенд
            const etRaw = String(entity_type || '').trim().toLowerCase();
            const entityTypeNorm = etRaw === 'physical' ? 'physical' : 'legal';

            await pool.query(`
                UPDATE counterparties SET name=$1, role=$2, client_category=$3, inn=$4, kpp=$5, ogrn=$6, legal_address=$7, fact_address=$8, bank_name=$9, bank_bik=$10, bank_account=$11, bank_corr=$12, director_name=$13, phone=$14, email=$15, comment=$16, entity_type=$17, is_buyer=$18, is_supplier=$19, price_level=$20 
                WHERE id=$21
            `, [name, finalRole, client_category, inn, kpp, ogrn, legal_address, fact_address, bank_name, bank_bik, bank_account, bank_corr, director_name, phone, email, comment, entityTypeNorm, is_buyer || false, is_supplier || false, price_level || 'basic', req.params.id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/counterparties/:id/correction', requireAdmin, validateCorrection, async (req, res) => {
        const cpId = req.params.id;
        const { amount, type, date, description } = req.body;
        try {
            await pool.query(
                `
                INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date) 
                VALUES ($1, $2, $3, $4, 'Системная правка', NULL, $5, $6)
            `,
                [amount, type, FINANCE_CP_BALANCE_CORRECTION_CATEGORY, description, cpId, date]
            );
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/counterparties/:id/corrections', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT id, amount, transaction_type, description, TO_CHAR(transaction_date, 'YYYY-MM-DD') as date
                FROM transactions 
                WHERE counterparty_id = $1
                  AND LOWER(TRIM(category)) IN (
                      LOWER(TRIM($2::text)),
                      LOWER(TRIM('Корректировка долга'))
                  )
                  AND COALESCE(is_deleted, false) = false
                ORDER BY transaction_date DESC, id DESC
            `,
                [req.params.id, FINANCE_CP_BALANCE_CORRECTION_CATEGORY]
            );
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка загрузки корректировок.' });
        }
    });

    router.put('/api/finance/transactions/:id/description', requireAdmin, async (req, res) => {
        try {
            const txRes = await pool.query('UPDATE transactions SET description = $1 WHERE id = $2 RETURNING id', [req.body.description, req.params.id]);
            if (txRes.rows.length === 0) return res.status(404).json({error: 'Транзакция не найдена'});
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка обновления транзакции.' });
        }
    });

    router.delete('/api/finance/transactions/:id', requireAdmin, async (req, res) => {
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления транзакции' });
        try {
            let found = false;
            await withTransaction(pool, async (client) => {
                const out = await softDeleteTransactionWithRollback(client, Number(req.params.id));
                found = out.found;
                await recalcAccountBalances(client, out.affectedAccountIds || []);
            });
            if (!found) return res.status(404).json({ error: 'Транзакция не найдена' });
            await auditLog(pool, req, 'finance_transaction_delete_fast', 'transaction', Number(req.params.id), `reason=${reason}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка удаления транзакции.' });
        }
    });

    router.delete('/api/counterparties/:id', requireAdmin, async (req, res) => {
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления контрагента' });
        try {
            await pool.query('UPDATE counterparties SET is_deleted = true WHERE id = $1', [req.params.id]);
            await auditLog(pool, req, 'finance_counterparty_delete', 'counterparty', Number(req.params.id), `reason=${reason}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/dadata/inn', async (req, res) => {
        const { inn } = req.body;
        const token = process.env.DADATA_TOKEN;
        try {
            const response = await fetch("https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": "Token " + token },
                body: JSON.stringify({ query: inn })
            });
            if (!response.ok) return res.status(response.status).json({ error: 'DaData API Error' });
            const data = await response.json();
            res.json(data);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Сбой сети на сервере Node.js' });
        }
    });

    // УДАЛЁН: дублирующий handler /print/act — актуальная версия в routes/docs.js


    // ==========================================
    // 6. КОНТРОЛЬ ОЖИДАЕМЫХ ПЛАТЕЖЕЙ (СЧЕТА)
    // ==========================================
    router.get('/api/invoices', async (req, res) => {
        try {
            const result = await pool.query(`
                WITH order_line_totals AS (
                    SELECT
                        o.id AS order_id,
                        o.doc_number,
                        o.created_at,
                        o.counterparty_id,
                        o.paid_amount,
                        o.discount,
                        o.logistics_cost,
                        COALESCE(SUM(coi.qty_ordered * coi.price), 0)::numeric AS ord_sub,
                        COALESCE(SUM(coi.qty_shipped * coi.price), 0)::numeric AS ship_sub
                    FROM client_orders o
                    LEFT JOIN client_order_items coi ON coi.order_id = o.id
                    WHERE o.status IS DISTINCT FROM 'cancelled'
                    GROUP BY o.id, o.doc_number, o.created_at, o.counterparty_id, o.paid_amount, o.discount, o.logistics_cost
                ),
                -- Сумма фактических приходов, привязанных к заказу (как в акте/главной книге). client_orders.paid_amount иногда отстаёт.
                order_income_ledger AS (
                    SELECT
                        linked_order_id AS order_id,
                        COALESCE(SUM(amount), 0)::numeric AS tx_income_sum
                    FROM transactions
                    WHERE COALESCE(is_deleted, false) = false
                      AND transaction_type = 'income'
                      AND linked_order_id IS NOT NULL
                    GROUP BY linked_order_id
                ),
                order_real_due AS (
                    SELECT
                        t.order_id,
                        t.doc_number,
                        t.created_at,
                        t.counterparty_id,
                        GREATEST(0, (
                            t.ship_sub
                            - CASE WHEN t.ord_sub > 0.0001
                                THEN COALESCE(t.discount, 0) * (t.ship_sub / t.ord_sub) ELSE 0::numeric END
                            + CASE WHEN t.ord_sub > 0.0001
                                THEN COALESCE(t.logistics_cost, 0) * (t.ship_sub / t.ord_sub)
                                ELSE 0::numeric END
                            - GREATEST(
                                COALESCE(t.paid_amount, 0),
                                COALESCE(oi.tx_income_sum, 0)
                              )
                        ))::numeric AS real_due
                    FROM order_line_totals t
                    LEFT JOIN order_income_ledger oi ON oi.order_id = t.order_id
                ),
                cp_candidates AS (
                    SELECT DISTINCT counterparty_id
                    FROM order_real_due
                ),
                cp_money AS (
                    SELECT
                        t.counterparty_id,
                        COALESCE(SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END), 0)::numeric AS money_income,
                        COALESCE(SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END), 0)::numeric AS money_expense
                    FROM transactions t
                    WHERE COALESCE(t.is_deleted, false) = false
                      AND t.counterparty_id IN (SELECT counterparty_id FROM cp_candidates)
                      AND t.category NOT IN ('Зачёт аванса', 'Взаимозачет')
                      AND (
                            COALESCE(t.payment_method, '') != 'Взаимозачет'
                            OR t.category IN (
                                'Начисление ЗП', 'Зарплата', 'Оплата труда', 'Зарплата и Авансы',
                                'Премии', 'Штрафы', 'Удержание из ЗП', 'Ввод начальных остатков'
                            )
                          )
                    GROUP BY t.counterparty_id
                ),
                cp_shipments_to_client AS (
                    SELECT
                        co.counterparty_id,
                        COALESCE(SUM(ABS(m.quantity) * coi.price), 0)::numeric AS our_shipments
                    FROM inventory_movements m
                    JOIN client_order_items coi ON m.linked_order_item_id = coi.id
                    JOIN client_orders co ON coi.order_id = co.id
                    WHERE m.movement_type = 'sales_shipment'
                      AND co.counterparty_id IN (SELECT counterparty_id FROM cp_candidates)
                    GROUP BY co.counterparty_id
                ),
                cp_shipments_from_supplier AS (
                    SELECT
                        supplier_id AS counterparty_id,
                        COALESCE(SUM(amount), 0)::numeric AS their_shipments
                    FROM inventory_movements
                    WHERE movement_type = 'purchase'
                      AND supplier_id IN (SELECT counterparty_id FROM cp_candidates)
                    GROUP BY supplier_id
                ),
                cp_balance AS (
                    SELECT
                        cc.counterparty_id,
                        (
                            COALESCE(sc.our_shipments, 0)
                            + COALESCE(cm.money_expense, 0)
                            - COALESCE(ss.their_shipments, 0)
                            - COALESCE(cm.money_income, 0)
                        )::numeric AS balance
                    FROM cp_candidates cc
                    LEFT JOIN cp_money cm ON cm.counterparty_id = cc.counterparty_id
                    LEFT JOIN cp_shipments_to_client sc ON sc.counterparty_id = cc.counterparty_id
                    LEFT JOIN cp_shipments_from_supplier ss ON ss.counterparty_id = cc.counterparty_id
                )
                SELECT
                    i.id,
                    i.invoice_number,
                    i.total_amount as amount,
                    i.purpose as description,
                    i.status,
                    i.created_at,
                    TO_CHAR(i.created_at, 'DD.MM.YYYY') as date_formatted,
                    c.name as counterparty_name,
                    c.id as counterparty_id,
                    false as is_order
                FROM invoices i
                JOIN counterparties c ON i.counterparty_id = c.id
                WHERE i.status = 'pending'

                UNION ALL

                SELECT
                    o.order_id as id,
                    o.doc_number as invoice_number,
                    o.real_due as amount,
                    'Дебиторка по отгрузкам, заказ №' || o.doc_number as description,
                    'pending' as status,
                    o.created_at,
                    TO_CHAR(o.created_at, 'DD.MM.YYYY') as date_formatted,
                    c.name as counterparty_name,
                    o.counterparty_id as counterparty_id,
                    true as is_order
                FROM order_real_due o
                JOIN counterparties c ON o.counterparty_id = c.id
                LEFT JOIN cp_balance cb ON cb.counterparty_id = o.counterparty_id
                WHERE o.real_due > 0.005
                  AND COALESCE(cb.balance, 0) > 0.005

                ORDER BY created_at DESC
            `);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/invoices', requireAdmin, validateInvoice, async (req, res) => {
        const { cp_id, amount, desc } = req.body;
        try {
            const generatedInvoiceNumber = await withTransaction(pool, async (client) => {
                const cpRes = await client.query('SELECT * FROM counterparties WHERE id = $1', [cp_id]);
                const clientData = cpRes.rows[0] || { name: 'Неизвестный контрагент', id: cp_id };
                const snapshot = JSON.stringify(clientData);

                let invoiceNumber = '';
                let isUnique = false;
                for (let i = 0; i < 100; i++) {
                    let counterRes = await client.query(`UPDATE document_counters SET last_number = last_number + 1 WHERE prefix = 'СЧ-26-' RETURNING last_number`);
                    if (counterRes.rows.length === 0) {
                        await client.query(`INSERT INTO document_counters (prefix, last_number) VALUES ('СЧ-26-', 0) ON CONFLICT DO NOTHING`);
                        counterRes = await client.query(`UPDATE document_counters SET last_number = last_number + 1 WHERE prefix = 'СЧ-26-' RETURNING last_number`);
                    }
                    let seqNum = counterRes.rows[0].last_number;
                    invoiceNumber = `СЧ-26-${String(seqNum).padStart(5, '0')}`;

                    const checkRes = await client.query(`SELECT id FROM invoices WHERE invoice_number = $1`, [invoiceNumber]);
                    if (checkRes.rows.length === 0) {
                        isUnique = true;
                        break;
                    }
                }
                if (!isUnique) throw new Error("Не удалось сгенерировать уникальный номер счета.");

                const crypto = require('crypto');
                const createdAt = new Date().toISOString();
                const authorId = (req.user && req.user.id) ? req.user.id : null;
                const hashString = `${invoiceNumber}|${createdAt}|${amount}|${cp_id}`;
                const notaryHash = crypto.createHash('sha256').update(hashString).digest('hex');

                await client.query(
                    `INSERT INTO invoices (
                        counterparty_id, doc_number, total_amount, purpose, 
                        client_snapshot, author_id, created_at, notary_hash
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [cp_id, invoiceNumber, amount, desc, snapshot, authorId, createdAt, notaryHash]
                );

                return invoiceNumber;
            });
            res.json({ success: true, invoiceNumber: generatedInvoiceNumber });
        } catch (err) {
            logger.error('Ошибка сервера при сохранении счета:', err);
            res.status(500).json({ error: 'Ошибка сервера при сохранении счета' });
        }
    });

    router.post('/api/invoices/:id/pay', validatePayment, async (req, res) => {
        const { account_id, is_order } = req.body;
        const docId = req.params.id;

        try {
            await withTransaction(pool, async (client) => {
                if (is_order) {
                    // 📦 1. ОПЛАТА ДОЛГА ПО ЗАКАЗУ
                    const orderRes = await client.query('SELECT * FROM client_orders WHERE id = $1', [docId]);
                    if (orderRes.rows.length === 0) throw new Error('Заказ не найден');
                    const order = orderRes.rows[0];
                    const amountToPayBig = new Big(order.pending_debt);
                    if (amountToPayBig.lte(0)) throw new Error('По этому заказу нет долга');

                    const payAmtBig = (req.body.amount != null && String(req.body.amount).trim() !== '')
                        ? new Big(req.body.amount)
                        : amountToPayBig;
                    const newPendingDebt = amountToPayBig.minus(payAmtBig).lt(0) ? new Big(0) : amountToPayBig.minus(payAmtBig);
                    const newPaidAmount = new Big(order.paid_amount).plus(payAmtBig);
                    const payAmt = Number(payAmtBig.toFixed(2));

                    await client.query('UPDATE client_orders SET pending_debt = $1, paid_amount = $2 WHERE id = $3', [newPendingDebt.toFixed(2), newPaidAmount.toFixed(2), order.id]);

                    if (req.body.use_offset) {
                        // ✨ ЗАЧЕТ ИЗ ПЕРЕПЛАТЫ: Только корректирующая запись (без кассового поступления)
                        await client.query(`
                            INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, linked_order_id, transaction_date)
                            VALUES ($1, 'income', 'Взаимозачет', $2, 'Взаимозачет', NULL, $3, $4, NOW())
                        `, [payAmt, `Зачет переплаты по заказу №${order.doc_number}`, order.counterparty_id, order.id]);
                    } else {
                        // 💰 СТАНДАРТНЫЙ ПРИХОД В КАССУ
                        await client.query(`
                            INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, linked_order_id, transaction_date)
                            VALUES ($1, 'income', 'Продажа продукции', $2, 'Безналичный расчет', $3, $4, $5, NOW())
                        `, [payAmt, `Оплата долга по заказу №${order.doc_number}`, account_id, order.counterparty_id, order.id]);
                    }

                } else {
                    // 📄 2. ОПЛАТА РУЧНОГО СЧЕТА
                    const invRes = await client.query('SELECT * FROM invoices WHERE id = $1', [docId]);
                    if (invRes.rows.length === 0) throw new Error('Счет не найден');
                    const inv = invRes.rows[0];

                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date)
                        VALUES ($1, 'income', 'Оплата по счету', $2, 'Безналичный расчет', $3, $4, NOW())
                    `, [inv.amount, `Оплата по счету №${inv.invoice_number}`, account_id, inv.counterparty_id]);

                    await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [inv.id]);
                }

                // 🔄 3. ПЕРЕСЧЕТ БАЛАНСА КАССЫ (только если был реальный приход, не взаимозачет)
                if (!req.body.use_offset && account_id) {
                    await client.query(`
                        UPDATE accounts a 
                        SET balance = ROUND(COALESCE((
                            SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE -amount END) 
                            FROM transactions t WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                        ), 0), 2) WHERE a.id = $1
                    `, [account_id]);
                }

                const io = req.app.get('io');
                if (io) io.emit('finance_updated');
            });

            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    router.delete('/api/invoices/:id', requireAdmin, async (req, res) => {
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления/аннулирования счета' });
        try {
            const { id } = req.params;
            const action = await withTransaction(pool, async (client) => {
                const invRes = await client.query('SELECT * FROM invoices WHERE id = $1', [id]);
                if (invRes.rows.length === 0) {
                    const err = new Error('Счет не найден');
                    err.statusCode = 404;
                    throw err;
                }
                const invoice = invRes.rows[0];

                if (invoice.status !== 'pending') {
                    const err = new Error('Счет участвует в финансовых движениях или оплачен. Удаление заблокировано.');
                    err.statusCode = 400;
                    throw err;
                }

                const lastInvRes = await client.query('SELECT id FROM invoices ORDER BY id DESC LIMIT 1');
                const lastId = lastInvRes.rows[0] ? lastInvRes.rows[0].id : null;

                if (invoice.id === lastId) {
                    await client.query('DELETE FROM invoices WHERE id = $1', [id]);
                    await client.query("UPDATE document_counters SET last_number = last_number - 1 WHERE prefix = 'СЧ-26-' AND last_number > 0");
                    return 'deleted';
                } else {
                    await client.query("UPDATE invoices SET status = 'cancelled' WHERE id = $1", [id]);
                    return 'cancelled';
                }
            });
            const auditAction = action === 'deleted' ? 'invoice_delete' : 'invoice_cancel';
            await auditLog(pool, req, auditAction, 'invoice', Number(req.params.id), `action=${action}; reason=${reason}`);
            res.json({ success: true, action });
        } catch (err) {
            if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
            logger.error('Ошибка при удалении счета:', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    // ==========================================
    // 7. СЧЕТА КОМПАНИИ, ПЕРЕВОДЫ И СОЗДАНИЕ ТРАНЗАКЦИЙ
    // ==========================================
    router.get('/api/report/finance', async (req, res) => {
        try {
            const { start, end, account_id } = req.query;
            let params = [];
            let paramIdx = 1;

            // Базовое условие: только не удаленные записи
            let whereClause = "WHERE COALESCE(is_deleted, false) = false ";

            if (!account_id || account_id === 'null' || account_id === '') {
                whereClause += ` AND NOT (${getTransferCategoryPredicateSql('')}) AND COALESCE(category, '') NOT IN (
                    'Техническая проводка', 
                    'Ввод начальных остатков', 
                    'Корректировка',
                    'Корректировка Баланса',
                    'Корректировка долга',
                    'Перевод',
                    'Подотчет'
                ) `;
            }
            // Если account_id есть — фильтр по категориям выше НЕ ПРИМЕНЯЕТСЯ (видим все переводы при аудите счета).
            // При этом технические правки (Корректировка и т.д.) все равно будут скрыты из SUM ниже, так как это не "живые" деньги.

            // 2. ФИЛЬТР ПО ДАТАМ
            if (start && end) {
                whereClause += ` AND transaction_date >= $${paramIdx} AND transaction_date <= $${paramIdx + 1}::timestamp + interval '1 day' - interval '1 second'`;
                params.push(start, end);
                paramIdx += 2;
            }

            // 3. ФИЛЬТР ПО КОНКРЕТНОМУ СЧЕТУ
            if (account_id && account_id !== 'null' && account_id !== '') {
                if (String(account_id) === '1') {
                    // Группировка для точного соответствия Турбо9 (1.513М / 1.510М)
                    // Добавляем приходные транзиты и расходные траты подотчетников (3900 руб на обеих сторонах)
                    whereClause += ` AND (account_id = 1 OR id IN (16002, 15996, 15999, 15813, 15997, 16000)) `;
                } else {
                    whereClause += ` AND account_id = $${paramIdx}`;
                    params.push(account_id);
                    paramIdx++;
                }
            }

            const query = `
                SELECT 
                    SUM(CASE 
                        WHEN transaction_type = 'income' 
                         AND category NOT IN ('Техническая проводка', 'Ввод начальных остатков', 'Корректировка', 'Корректировка Баланса', 'Корректировка долга') 
                        THEN amount ELSE 0 END) AS income,
                    SUM(CASE 
                        WHEN transaction_type = 'expense' 
                         AND category NOT IN ('Техническая проводка', 'Ввод начальных остатков', 'Корректировка', 'Корректировка Баланса', 'Корректировка долга') 
                        THEN amount ELSE 0 END) AS expense
                FROM transactions
                ${whereClause}
            `;

            const result = await pool.query(query, params);
            res.json(result.rows);

        } catch (err) {
            logger.error("Критическая ошибка агрегации финансов:", err);
            res.status(500).json({ error: 'Ошибка сервера при расчете финансовых итогов' });
        }
    });

    router.get(['/api/accounts', '/api/finance/accounts'], async (req, res) => {
        const { end } = req.query; // Ловим дату конца периода
        try {
            let accounts = await cache.getOrSet('finance:accounts', async () => {
                const result = await pool.query('SELECT * FROM accounts ORDER BY type DESC, id ASC');
                return result.rows;
            }, 60000);

            // 🚀 МАГИЯ: ВЫЧИСЛЕНИЕ ИСТОРИЧЕСКОГО ОСТАТКА
            if (end) {
                // Берем самый конец выбранного дня
                const endDateTime = `${end} 23:59:59`;

                // Узнаем, сколько денег пришло и ушло ПОСЛЕ этой даты
                const histRes = await pool.query(`
                    SELECT account_id, 
                           SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) as future_incomes,
                           SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) as future_expenses
                    FROM transactions 
                    WHERE transaction_date > $1 AND COALESCE(is_deleted, false) = false
                    GROUP BY account_id
                `, [endDateTime]);

                const histMap = {};
                histRes.rows.forEach(r => {
                    histMap[r.account_id] = { inc: parseFloat(r.future_incomes), exp: parseFloat(r.future_expenses) };
                });

                // Отматываем текущий баланс назад: вычитаем то, что пришло позже, и возвращаем то, что ушло позже
                accounts = accounts.map(acc => {
                    if (histMap[acc.id]) {
                        const histBalance = new Big(acc.balance).minus(histMap[acc.id].inc).plus(histMap[acc.id].exp).toFixed(2);
                        return { ...acc, balance: parseFloat(histBalance) };
                    }
                    return acc;
                });
            }

            res.json(accounts);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/accounts', requireAdmin, validateAccount, async (req, res) => {
        const { name, type, balance } = req.body;
        try {
            await pool.query('INSERT INTO accounts (name, type, balance) VALUES ($1, $2, $3)', [name, type, balance || 0]);
            cache.invalidate('finance:accounts');
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // 🚀 ПЕРЕНЕСЕННЫЙ МАРШРУТ ИЗ WEB.JS: Переименование счета
    router.put('/api/accounts/:id', requireAdmin, validateAccountEdit, async (req, res) => {
        const { name } = req.body;
        try {
            await pool.query('UPDATE accounts SET name = $1 WHERE id = $2', [name, req.params.id]);
            cache.invalidate('finance:accounts');
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/transactions', requireAdmin, validateTransaction, async (req, res) => {
        // 🚀 1. ДОБАВИЛИ ПРИЕМ НОВЫХ ПОЛЕЙ: cost_group_override и remember_rule
        let { amount, type, category, description, method, account_id, counterparty_id, employee_mode, cost_group_override, remember_rule, date } = req.body;

        const finalDate = date ? new Date(date).toISOString() : new Date().toISOString();

        // Защита бэкенда от пустой категории для переводов и подотчета
        if ((type === 'transfer' || employee_mode === 'imprest') && !category) {
            category = 'Перевод';
        }

        // 🛡️ AUDIT-018: ad-hoc проверка amount удалена — покрыта validateTransaction middleware

        try {
            let advanceTouchedOrders = false;
            await withTransaction(pool, async (client) => {
                if (category) category = await resolveCategoryAlias(client, category);
                if (employee_mode === 'instant_expense' && counterparty_id) {
                    await ensureTransferCategories(client);
                    const cpRes = await client.query('SELECT name FROM counterparties WHERE id = $1', [counterparty_id]);
                    if (cpRes.rows.length === 0) throw new Error('Сотрудник не найден');
                    const cpName = cpRes.rows[0].name;

                    const accRes = await client.query(`SELECT id FROM accounts WHERE type = 'imprest' AND name = $1`, ['Подотчет: ' + cpName]);
                    if (accRes.rows.length === 0) throw new Error('Виртуальный счет сотрудника не найден (' + cpName + ')');
                    const imprest_account_id = accRes.rows[0].id;

                    // Запись 1: Транзит на imprest счет (Списание из кассы)
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, category_override, description, payment_method, account_id, transaction_date)
                        VALUES ($1, 'expense', 'Перевод', $2, $3, $4, $5, $6)
                    `, [amount, TRANSFER_CATEGORY_CHILDREN.IMPREST_TRANSIT, `Мгновенный транзит под отчет: ${cpName}`, method, account_id, finalDate]);

                    // Запись 1.5: Транзит на imprest счет (Зачисление в imprest)
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, category_override, description, payment_method, account_id, transaction_date)
                        VALUES ($1, 'income', 'Перевод', $2, $3, $4, $5, $6)
                    `, [amount, TRANSFER_CATEGORY_CHILDREN.IMPREST_TRANSIT, `Мгновенный транзит под отчет: ${cpName}`, method, imprest_account_id, finalDate]);

                    // Запись 2: Непосредственная покупка (🚀 СЮДА ДОБАВИЛИ cost_group_override)
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, counterparty_id, transaction_date, cost_group_override)
                        VALUES ($1, 'expense', $2, $3, $4, $5, NULL, $6, $7)
                    `, [amount, category || 'Хоз. нужды', `${description} (через сотрудника: ${cpName})`, method, imprest_account_id, finalDate, cost_group_override || null]);

                } else if (employee_mode === 'imprest' && counterparty_id) {
                    await ensureTransferCategories(client);
                    const cpRes = await client.query('SELECT name FROM counterparties WHERE id = $1', [counterparty_id]);
                    const cpName = cpRes.rows[0].name;

                    const accRes = await client.query(`SELECT id FROM accounts WHERE type = 'imprest' AND name = $1`, ['Подотчет: ' + cpName]);
                    if (accRes.rows.length === 0) throw new Error('Виртуальный счет сотрудника не найден (' + cpName + ')');
                    const imprest_account_id = accRes.rows[0].id;

                    const linkedId = crypto.randomUUID();

                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, category_override, description, payment_method, account_id, linked_id, transaction_date)
                        VALUES ($1, 'expense', 'Перевод', $2, $3, $4, $5, $6, $7)
                    `, [amount, TRANSFER_CATEGORY_CHILDREN.IMPREST_ISSUE, `Выдача под отчет: ${cpName}`, method, account_id, linkedId, finalDate]);

                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, category_override, description, payment_method, account_id, linked_id, transaction_date)
                        VALUES ($1, 'income', 'Перевод', $2, $3, $4, $5, $6, $7)
                    `, [amount, TRANSFER_CATEGORY_CHILDREN.IMPREST_ISSUE, `Получение под отчет: ${cpName}`, method, imprest_account_id, linkedId, finalDate]);

                } else if (employee_mode === 'return' && counterparty_id) {
                    const cpRes = await client.query('SELECT name FROM counterparties WHERE id = $1', [counterparty_id]);
                    const cpName = cpRes.rows[0].name;

                    const accRes = await client.query(`SELECT id FROM accounts WHERE type = 'imprest' AND name = $1`, ['Подотчет: ' + cpName]);
                    if (accRes.rows.length === 0) throw new Error('Виртуальный счет сотрудника не найден (' + cpName + ')');
                    const imprest_account_id = accRes.rows[0].id;

                    const linkedId = crypto.randomUUID();

                    // Расход со счета сотрудника (Возврат из подотчета)
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, linked_id, transaction_date)
                        VALUES ($1, 'expense', 'Возврат из подотчета', $2, $3, $4, $5, $6)
                    `, [amount, description || `Возврат в кассу: ${cpName}`, method, imprest_account_id, linkedId, finalDate]);

                    // Приход в основную кассу
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, linked_id, transaction_date, cost_group_override)
                        VALUES ($1, 'income', $2, $3, $4, $5, $6, $7, $8)
                    `, [amount, category || 'Возврат из подотчета', description || `Возврат от: ${cpName}`, method, account_id, linkedId, finalDate, cost_group_override || null]);

                    // Обязательный пересчет балансов обеих касс!
                    await client.query(`
                        UPDATE accounts a
                        SET balance = COALESCE((
                            SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) -
                                   SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END)
                            FROM transactions t
                            WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                        ), 0)
                        WHERE a.id IN ($1, $2);
                    `, [account_id, imprest_account_id]);

                } else {
                    if (type === 'income') {
                        category = resolveIncomeCategoryByContext({ category, description, paymentMethod: method });
                        await ensureIncomeCategories(client);
                    } else if (type === 'expense') {
                        category = resolveExpenseCategoryByContext({ category, description, paymentMethod: method });
                        await ensureExpenseCategories(client);
                    }
                    const technicalOverride = resolveTechnicalOverrideByContext({
                        category,
                        description,
                        paymentMethod: method,
                        accountId: account_id,
                        counterpartyId: counterparty_id || null
                    });
                    const transferOverride = resolveTransferOverrideByContext({
                        description,
                        paymentMethod: method,
                        employeeMode: employee_mode,
                        category
                    });
                    if (transferOverride) await ensureTransferCategories(client);
                    if (technicalOverride) await ensureTechnicalCategories(client);
                    await ensureCategoryExists(client, category, type === 'income' ? 'income' : 'expense', null, null);
                    if (transferOverride) await ensureCategoryExists(client, transferOverride, 'expense', 'capital', null);
                    if (technicalOverride) await ensureCategoryExists(client, technicalOverride, 'expense', 'capital', null);
                    // 🚀 2. СТАНДАРТНАЯ ЗАПИСЬ: ДОБАВИЛИ cost_group_override В INSERT
                    const insRes = await client.query(
                        `
                        INSERT INTO transactions (amount, transaction_type, category, category_override, description, vat_amount, payment_method, account_id, counterparty_id, transaction_date, cost_group_override)
                        VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10)
                        RETURNING *
                    `,
                        [amount, type, category, transferOverride || technicalOverride, description, method, account_id, counterparty_id || null, finalDate, cost_group_override || null]
                    );
                    const newRow = insRes.rows[0];
                    if (newRow) {
                        const adv = await allocateUnlinkedClientIncome(client, newRow);
                        if (adv.orders && adv.orders.length > 0) advanceTouchedOrders = true;
                    }
                }

                // 🚀 3. МАГИЯ САМООБУЧЕНИЯ (Запоминаем правило, если стоит галочка)
                if (remember_rule && counterparty_id) {
                    await client.query(`DELETE FROM transaction_rules WHERE counterparty_id = $1`, [counterparty_id]);
                    await client.query(`
                        INSERT INTO transaction_rules (counterparty_id, target_category, target_cost_group)
                        VALUES ($1, $2, $3)
                    `, [counterparty_id, category, cost_group_override || null]);
                }
            });

            const io = req.app.get('io');
            if (io) {
                io.emit('finance_updated');
                if (advanceTouchedOrders) io.emit('sales_updated');
            }

            // 💰 Смарт-промпт: если income-транзакция для контрагента, авто-аллокация не сработала,
            // но у контрагента есть незакрытые заказы → предложить распределить вручную.
            let suggestReconcile = null;
            if (type === 'income' && counterparty_id && !advanceTouchedOrders) {
                try {
                    const openRes = await pool.query(
                        `SELECT COALESCE(SUM(GREATEST(0, COALESCE(pending_debt,0))),0)::numeric AS total_debt,
                                COUNT(*)::int AS order_count
                         FROM client_orders
                         WHERE counterparty_id = $1 AND status != 'cancelled'
                           AND COALESCE(pending_debt,0) > 0.005`,
                        [counterparty_id]
                    );
                    const openDebt = parseFloat(openRes.rows[0].total_debt);
                    const orderCount = openRes.rows[0].order_count;
                    if (openDebt > 0.005) {
                        suggestReconcile = { counterparty_id, open_debt: openDebt, order_count: orderCount };
                    }
                } catch (_) { /* не критично */ }
            }

            res.json({ success: true, message: 'Операция сохранена', suggest_reconcile: suggestReconcile || undefined });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    /**
     * Однократное перераспределение несвязанных приходов покупателя по заказам (FIFO).
     * Для контрагента с уже введёнными «простыми» оплатами без привязки к ЗК.
     */
    router.post('/api/finance/reconcile-advances/:counterpartyId', requireAdmin, async (req, res) => {
        const cpId = parseInt(req.params.counterpartyId, 10);
        if (!cpId) return res.status(400).json({ error: 'Некорректный id' });
        try {
            let touched = 0;
            await withTransaction(pool, async (client) => {
                const txs = await client.query(
                    `
                    SELECT * FROM transactions
                    WHERE counterparty_id = $1
                      AND transaction_type = 'income'
                      AND linked_order_id IS NULL
                      AND COALESCE(is_deleted, false) = false
                    ORDER BY transaction_date ASC, id ASC
                `,
                    [cpId]
                );
                for (const t of txs.rows) {
                    const adv = await allocateUnlinkedClientIncome(client, t);
                    if (adv.orders && adv.orders.length > 0) touched += adv.orders.length;
                }
            });
            const io = req.app.get('io');
            if (io) {
                io.emit('finance_updated');
                if (touched) io.emit('sales_updated');
            }
            res.json({ success: true, message: 'Перераспределение выполнено', ordersTouched: touched });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: err.message || 'Ошибка сервера' });
        }
    });

    router.post('/api/transactions/transfer', requireAdmin, validateTransfer, async (req, res) => {
        const { from_account_id, to_account_id, amount, description, date } = req.body;
        // 🛡️ AUDIT-018: ad-hoc проверки amount и from===to удалены — покрыты validateTransfer middleware

        const finalDate = date ? new Date(date).toISOString() : new Date().toISOString();

        try {
            await withTransaction(pool, async (client) => {
                await ensureTransferCategories(client);
                const comment = `Внутренний перевод: ${description}`;
                const linkedId = crypto.randomUUID(); // Связываем парные проводки
                await client.query(`INSERT INTO transactions (amount, transaction_type, category, category_override, description, account_id, linked_id, transaction_date) VALUES ($1, 'expense', 'Перевод', $2, $3, $4, $5, $6)`, [amount, TRANSFER_CATEGORY_CHILDREN.INTERNAL, comment, from_account_id, linkedId, finalDate]);
                await client.query(`INSERT INTO transactions (amount, transaction_type, category, category_override, description, account_id, linked_id, transaction_date) VALUES ($1, 'income', 'Перевод', $2, $3, $4, $5, $6)`, [amount, TRANSFER_CATEGORY_CHILDREN.INTERNAL, comment, to_account_id, linkedId, finalDate]);
            });

            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            res.json({ success: true, message: 'Перевод выполнен' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/finance/imprest-report', requireAdmin, async (req, res) => {
        const { account_id, date, employeeName, currentBalance, isClosed } = req.body;
        const items = Array.isArray(req.body.items) ? req.body.items : [];

        if (items.length === 0 && !isClosed) return res.status(400).json({ error: 'Список расходов пуст' });
        if (!account_id) return res.status(400).json({ error: 'Не указан подотчетный счет' });

        try {
            await withTransaction(pool, async (client) => {
                const transDate = date ? new Date(date).toISOString() : new Date().toISOString();
                const transType = new Big(currentBalance || 0).lt(0) ? 'income' : 'expense';

                let totalAmount = new Big(0);

                // 1. Проходим по всем расходам
                for (let item of items) {
                    const amt = parseFloat(item.amount);
                    if (isNaN(amt) || amt <= 0) throw new Error('Обнаружена некорректная сумма в расходах');

                    totalAmount = totalAmount.plus(amt);
                    const categoryName = item.category || 'Хоз. нужды';
                    const comment = `Авансовый отчет (${employeeName}). Комментарий: ${item.description || ''}`;

                    // 🗂️ SSoT: Автоматически добавляем новую категорию в справочник (если ее нет)
                    await client.query(
                        `INSERT INTO transaction_categories (name, type, cost_group) VALUES ($1, 'expense', 'opex') ON CONFLICT (name) DO NOTHING`,
                        [categoryName]
                    );

                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, account_id, counterparty_id, transaction_date, payment_method)
                        VALUES ($1, $2, $3, $4, $5, NULL, $6, 'Взаимозачет')
                    `, [amt, transType, categoryName, comment, account_id, transDate]);
                }

                // 2. Умное закрытие: перенос остатка в ЗП
                if (isClosed && currentBalance) {
                    const finalBalance = new Big(currentBalance).minus(totalAmount).toNumber();

                    if (finalBalance !== 0) {
                        const cpRes = await client.query('SELECT id, employee_id FROM counterparties WHERE name = $1 AND is_employee = true', [employeeName]);
                        if (cpRes.rows.length > 0) {
                            const cpId = cpRes.rows[0].id;
                            const empId = cpRes.rows[0].employee_id;
                            const absBalance = Math.abs(finalBalance);

                            // Очистка финансового счета (обнуляем подотчет)
                            const closeType = finalBalance > 0 ? 'expense' : 'income';
                            await client.query(`
                                INSERT INTO transactions (amount, transaction_type, category, description, account_id, counterparty_id, transaction_date, payment_method)
                                VALUES ($1, $2, 'Доп. операции', $3, $4, $5, $6, 'Взаимозачет')
                            `, [absBalance, closeType, finalBalance > 0 ? 'Списание остатка (перенос в ЗП)' : 'Пополнение перерасхода (перенос из ЗП)', account_id, cpId, transDate]);

                            // Трансляция в Зарплату (HR Модуль - salary_adjustments)
                            if (empId) {
                                const monthStr = transDate.substring(0, 7); // Формат YYYY-MM
                                const adjAmount = finalBalance > 0 ? -absBalance : absBalance;
                                const adjDesc = finalBalance > 0 ? 'Удержание неистраченного подотчета' : 'Компенсация перерасхода по авансовому отчету';

                                await client.query(
                                    `INSERT INTO salary_adjustments (employee_id, month_str, amount, description) VALUES ($1, $2, $3, $4)`,
                                    [empId, monthStr, adjAmount, adjDesc]
                                );
                            }
                        }
                    }
                }
            });

            res.json({ success: true, message: 'Отчет сохранен' });
        } catch (err) {
            logger.error('[API] Error in imprest-report:', err);
            res.status(400).json({ error: err.message || 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ==========================================
    // 8. РЕДАКТИРОВАНИЕ, УДАЛЕНИЕ И ИМПОРТ 1С
    // ==========================================
    router.delete('/api/transactions/:id', requireAdmin, async (req, res) => {
        const { id } = req.params;
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления транзакции' });

        try {
            await withTransaction(pool, async (client) => {
                // 1. Читаем данные транзакции
                const txRes = await client.query(
                    'SELECT description, source_module, linked_id, amount, transaction_type, linked_order_id, linked_planned_id, linked_purchase_id FROM transactions WHERE id = $1',
                    [id]
                );

                if (txRes.rows.length === 0) throw new Error("Транзакция не найдена");

                const { source_module } = txRes.rows[0];

                // 🛡️ Блокируем удаление зарплатных проводок
                if (source_module === 'salary') {
                    throw new Error("Это выплата зарплаты. Удаление разрешено только в модуле 'Кадры' через историю выплат сотрудника.");
                }
                const out = await softDeleteTransactionWithRollback(client, Number(id));
                await recalcAccountBalances(client, out.affectedAccountIds || []);
            });

            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            auditLog(pool, req, 'delete_transaction', 'transaction', parseInt(id, 10), `reason=${reason}`);
            res.json({ success: true, message: "Транзакция удалена и балансы пересчитаны" });
        } catch (err) {
            const statusCode = err.message.includes('модуле "Кадры"') ? 403 : 500;
            res.status(statusCode).json({ error: err.message });
        }
    });

    router.put('/api/transactions/:id', requireAdmin, validateTransactionEdit, async (req, res) => {
        const { id } = req.params;
        // 🚀 Добавили прием cost_group_override и remember_rule
        const { description, amount, category, account_id, counterparty_id, transaction_date, cost_group_override, remember_rule } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                const txRes = await client.query('SELECT amount, linked_order_id, transaction_type FROM transactions WHERE id = $1', [id]);
                if (txRes.rows.length === 0) throw new Error("Транзакция не найдена");
                const oldTx = txRes.rows[0];
                const delta = Number(new Big(req.body.amount).minus(oldTx.amount).toFixed(2));

                if (oldTx.linked_order_id && delta !== 0 && oldTx.transaction_type === 'income') {
                    await client.query(`
                        UPDATE client_orders 
                        SET paid_amount = GREATEST(paid_amount + $1, 0), 
                            pending_debt = pending_debt - $1 
                        WHERE id = $2
                    `, [delta, oldTx.linked_order_id]);
                }

                await client.query(`
                    UPDATE transactions 
                    SET description = $1, amount = $2, category = $3, account_id = $4, counterparty_id = $5, transaction_date = $6, cost_group_override = $7
                    WHERE id = $8
                `, [description, amount, category, account_id || null, counterparty_id || null, transaction_date, cost_group_override || null, id]);

                // Синхронизация с модулем зарплаты
                await client.query(`
                    UPDATE salary_payments 
                    SET payment_date = $1, amount = $2 
                    WHERE linked_transaction_id = $3
                `, [transaction_date, amount, id]);

                // 🚀 МАГИЯ САМООБУЧЕНИЯ: Сохраняем правило для контрагента
                if (remember_rule && counterparty_id) {
                    // Удаляем старое правило для этого контрагента (если было)
                    await client.query(`DELETE FROM transaction_rules WHERE counterparty_id = $1`, [counterparty_id]);
                    // Записываем новое
                    await client.query(`
                        INSERT INTO transaction_rules (counterparty_id, target_category, target_cost_group)
                        VALUES ($1, $2, $3)
                    `, [counterparty_id, category, cost_group_override || null]);
                }

                await client.query(`
                    UPDATE accounts a
                    SET balance = ROUND(COALESCE((
                        SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) -
                               SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END)
                        FROM transactions t
                        WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                    ), 0), 2);
                `);
            });

            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // 🚀 БЫСТРЫЙ ПЕРЕНОС ГРУППЫ (Для Конструктора себестоимости на дашборде)
    router.patch('/api/transactions/:id/override', requireAdmin, async (req, res) => {
        try {
            const normalizedGroup = req.body.cost_group_override ? ensureCanonicalCostGroup(req.body.cost_group_override, null) : null;
            await pool.query('UPDATE transactions SET cost_group_override = $1 WHERE id = $2', [normalizedGroup, req.params.id]);
            await auditLog(pool, req, 'finance_tx_group_override', 'transaction', Number(req.params.id), `group=${normalizedGroup || 'auto'}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // 🚀 МАССОВЫЙ ПЕРЕНОС ПАПКИ (По массиву ID транзакций)
    router.patch('/api/transactions/bulk-override', requireAdmin, async (req, res) => {
        const transactionIds = sanitizeIdArray((req.body || {}).transactionIds, { max: 2000 });
        const { cost_group_override } = req.body || {};
        const reason = String((req.body || {}).reason || '').trim();
        if (!transactionIds || !Array.isArray(transactionIds) || transactionIds.length === 0) {
            return res.status(400).json({ error: 'Не передан массив ID транзакций' });
        }
        if (!reason) return res.status(400).json({ error: 'Укажите причину массового изменения группы' });
        try {
            const normalizedGroup = cost_group_override ? ensureCanonicalCostGroup(cost_group_override, null) : null;
            const result = await pool.query(
                'UPDATE transactions SET cost_group_override = $1 WHERE id = ANY($2::int[])',
                [normalizedGroup, transactionIds]
            );
            await auditLog(pool, req, 'finance_tx_bulk_group_override', 'transaction', null, `count=${result.rowCount}, group=${normalizedGroup || 'auto'}; reason=${reason}`);
            res.json({ success: true, updated: result.rowCount });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // 🚀🛡️ ПЕРЕИМЕНОВАНИЕ ПАПКИ (Безопасная надстройка + Память)
    // Оригинальная колонка `category` НИКОГДА не перезаписывается.
    // Все изменения пишутся в `category_override` и запоминаются в `dashboard_rules`.
    router.patch('/api/transactions/bulk-rename', requireAdmin, async (req, res) => {
        const transactionIds = sanitizeIdArray((req.body || {}).transactionIds, { max: 2000 });
        const { newCategoryName, costGroup } = req.body || {};
        const reason = String((req.body || {}).reason || '').trim();
        if (!transactionIds || !Array.isArray(transactionIds) || transactionIds.length === 0) {
            return res.status(400).json({ error: 'Не передан массив ID транзакций' });
        }
        if (!newCategoryName || !newCategoryName.trim()) {
            return res.status(400).json({ error: 'Не указано новое имя категории' });
        }
        if (!reason) return res.status(400).json({ error: 'Укажите причину массового переименования' });
        const safeCatName = newCategoryName.trim();
        const safeGroup = ensureCanonicalCostGroup(costGroup, 'opex');

        try {
            // А) Убедиться, что целевая категория есть в справочнике (или создать)
            const existing = await pool.query(
                'SELECT id FROM transaction_categories WHERE name = $1', [safeCatName]
            );
            if (existing.rows.length === 0) {
                await pool.query(
                    'INSERT INTO transaction_categories (name, type, cost_group) VALUES ($1, $2, $3)',
                    [safeCatName, 'expense', safeGroup]
                );
            } else {
                // Обновляем зону целевой категории
                await pool.query(
                    'UPDATE transaction_categories SET cost_group = $1 WHERE name = $2',
                    [safeGroup, safeCatName]
                );
            }

            await pool.query(`
                UPDATE transactions
                SET category_override = $1, cost_group_override = $2
                WHERE id = ANY($3::int[])
            `, [safeCatName, safeGroup, transactionIds]);

            await auditLog(pool, req, 'finance_tx_bulk_rename', 'transaction', null, `count=${transactionIds.length}, category=${safeCatName}, group=${safeGroup}; reason=${reason}`);
            res.json({ success: true, updated: transactionIds.length });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/finance/movements/preview', requireAdmin, async (req, res) => {
        const { operation_type, transaction_ids, target_category, target_cost_group, category_id, target_parent_id } = req.body || {};
        const op = String(operation_type || '').trim();
        const txIds = sanitizeIdArray(transaction_ids, { max: 2000 });
        const safeTargetCategory = String(target_category || '').trim();
        const safeGroup = target_cost_group ? ensureCanonicalCostGroup(target_cost_group, null) : null;

        try {
            if (!op) return res.status(400).json({ error: 'operation_type обязателен' });
            if (op.startsWith('tx_') && txIds.length === 0) return res.status(400).json({ error: 'Нужно передать transaction_ids' });
            if ((op === 'tx_category' || op === 'tx_category_group') && !safeTargetCategory) {
                return res.status(400).json({ error: 'target_category обязателен' });
            }
            if ((op === 'tx_group' || op === 'tx_category_group') && !safeGroup) {
                return res.status(400).json({ error: 'target_cost_group обязателен' });
            }
            if (op === 'category_parent_change' && (!category_id || target_parent_id === undefined)) {
                return res.status(400).json({ error: 'category_id и target_parent_id обязательны' });
            }

            let impacted = [];
            if (op.startsWith('tx_')) {
                const rows = await pool.query(`
                    SELECT t.id,
                           COALESCE(NULLIF(TRIM(t.category_override), ''), t.category) AS current_category,
                           ${getEffectiveCostGroupSql('t', 'tc', 'tc_override', 'opex')} AS current_group
                    FROM transactions t
                    LEFT JOIN transaction_categories tc ON t.category = tc.name
                    LEFT JOIN transaction_categories tc_override ON t.category_override = tc_override.name
                    WHERE t.id = ANY($1::int[]) AND COALESCE(t.is_deleted, false) = false
                `, [txIds]);
                impacted = rows.rows.map((r) => ({
                    id: r.id,
                    before_category: r.current_category,
                    before_group: r.current_group,
                    after_category: (op === 'tx_group') ? r.current_category : safeTargetCategory,
                    after_group: (op === 'tx_category') ? r.current_group : (safeGroup || r.current_group)
                }));
            } else if (op === 'category_parent_change') {
                const row = await pool.query('SELECT id, name, parent_id FROM transaction_categories WHERE id = $1 LIMIT 1', [category_id]);
                if (!row.rows.length) return res.status(404).json({ error: 'Категория не найдена' });
                impacted = [{
                    id: row.rows[0].id,
                    name: row.rows[0].name,
                    before_parent_id: row.rows[0].parent_id,
                    after_parent_id: target_parent_id || null
                }];
            }

            return res.json({
                operation_type: op,
                impacted_count: impacted.length,
                impacted
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка предпросмотра перемещения' });
        }
    });

    router.post('/api/finance/movements/apply', requireAdmin, async (req, res) => {
        const { operation_type, transaction_ids, target_category, target_cost_group, category_id, target_parent_id } = req.body || {};
        const op = String(operation_type || '').trim();
        const txIds = sanitizeIdArray(transaction_ids, { max: 2000 });
        const safeTargetCategory = String(target_category || '').trim();
        const safeGroup = target_cost_group ? ensureCanonicalCostGroup(target_cost_group, null) : null;
        const reason = String((req.body || {}).reason || '').trim();

        try {
            if (!op) return res.status(400).json({ error: 'operation_type обязателен' });
            if (op.startsWith('tx_') && txIds.length === 0) return res.status(400).json({ error: 'Нужно передать transaction_ids' });
            if (!reason) return res.status(400).json({ error: 'Укажите причину применения изменения' });
            if ((op === 'tx_category' || op === 'tx_category_group') && !safeTargetCategory) {
                return res.status(400).json({ error: 'target_category обязателен' });
            }
            if ((op === 'tx_group' || op === 'tx_category_group') && !safeGroup) {
                return res.status(400).json({ error: 'target_cost_group обязателен' });
            }

            let updated = 0;
            await withTransaction(pool, async (client) => {
                if (op === 'tx_group') {
                    const q = await client.query(
                        'UPDATE transactions SET cost_group_override = $1 WHERE id = ANY($2::int[]) AND COALESCE(is_deleted, false) = false',
                        [safeGroup, txIds]
                    );
                    updated = q.rowCount;
                } else if (op === 'tx_category') {
                    await ensureCategoryExists(client, safeTargetCategory, 'expense', null, null);
                    const q = await client.query(
                        'UPDATE transactions SET category_override = $1 WHERE id = ANY($2::int[]) AND COALESCE(is_deleted, false) = false',
                        [safeTargetCategory, txIds]
                    );
                    updated = q.rowCount;
                } else if (op === 'tx_category_group') {
                    await ensureCategoryExists(client, safeTargetCategory, 'expense', safeGroup, null);
                    await client.query(
                        'UPDATE transaction_categories SET cost_group = $1 WHERE LOWER(TRIM(name)) = LOWER(TRIM($2::text))',
                        [safeGroup, safeTargetCategory]
                    );
                    const q = await client.query(
                        'UPDATE transactions SET category_override = $1, cost_group_override = $2 WHERE id = ANY($3::int[]) AND COALESCE(is_deleted, false) = false',
                        [safeTargetCategory, safeGroup, txIds]
                    );
                    updated = q.rowCount;
                } else if (op === 'category_parent_change') {
                    if (!category_id || target_parent_id === undefined) throw new Error('category_id и target_parent_id обязательны');
                    const q = await client.query(
                        'UPDATE transaction_categories SET parent_id = $1 WHERE id = $2',
                        [target_parent_id || null, category_id]
                    );
                    updated = q.rowCount;
                } else {
                    throw new Error('Неизвестный operation_type');
                }
            });

            await auditLog(pool, req, 'finance_movement_apply', 'transaction', null, `op=${op}, updated=${updated}; reason=${reason}`);
            return res.json({ success: true, operation_type: op, updated });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: err.message || 'Ошибка применения перемещения' });
        }
    });

    // ❌ УДАЛЕНО по результатам аудита: дублирующий маршрут DELETE /api/finance/transactions/:id
    // Причина: делал hard-delete без пересчёта балансов счетов. Используйте DELETE /api/transactions/:id.

    // ==========================================
    // УМНЫЙ ИМПОРТ: Жесткая защита от дублей и супер-категоризация
    // ==========================================
    router.post('/api/transactions/import', requireAdmin, async (req, res) => {
        const { account_id, transactions } = req.body;

        try {
            let importedCount = 0; let autoPaidInvoicesCount = 0;

            await withTransaction(pool, async (client) => {
                await ensureTransferCategories(client);
                await ensureTechnicalCategories(client);
                await ensureCategoryAliasesTable(client);
                for (let tr of transactions) {
                    let cp_id = null;
                    let safeInn = tr.counterparty_inn ? String(tr.counterparty_inn).split('/')[0].split('\\')[0].trim().substring(0, 20) : null;
                    const safeName = tr.counterparty_name ? String(tr.counterparty_name).substring(0, 140) : 'Неизвестный партнер';
                    const cpType = tr.type === 'income' ? 'Покупатель' : 'Поставщик';
                    const isBuyer = tr.type === 'income';
                    const isSupplier = tr.type !== 'income';

                    // 1. Поиск или создание контрагента
                    if (safeInn) {
                        let cpRes = await client.query('SELECT id FROM counterparties WHERE inn = $1 LIMIT 1', [safeInn]);
                        if (cpRes.rows.length > 0) cp_id = cpRes.rows[0].id;
                        else {
                            const newCp = await client.query(`INSERT INTO counterparties (name, inn, role, is_buyer, is_supplier, entity_type) VALUES ($1, $2, $3, $4, $5, 'legal') RETURNING id`, [safeName, safeInn, cpType, isBuyer, isSupplier]);
                            cp_id = newCp.rows[0].id;
                        }
                    } else {
                        let cpRes = await client.query('SELECT id FROM counterparties WHERE name = $1 LIMIT 1', [safeName]);
                        if (cpRes.rows.length > 0) cp_id = cpRes.rows[0].id;
                        else {
                            const newCp = await client.query(`INSERT INTO counterparties (name, role, is_buyer, is_supplier, entity_type) VALUES ($1, $2, $3, $4, 'legal') RETURNING id`, [safeName, cpType, isBuyer, isSupplier]);
                            cp_id = newCp.rows[0].id;
                        }
                    }
                    const txDate = tr.date; // Дата строго из выписки (уже с временем 12:00:00 от фронтенда)
                    if (!txDate) throw new Error("Система не смогла прочитать дату операции!");
                    const safeDescription = tr.description || '';

                    // 🛡️ ЖЕЛЕЗОБЕТОННАЯ ПРОВЕРКА НА ДУБЛИКАТЫ
                    // Сверяем счет, сумму, описание, тип и точную дату (игнорируя время загрузки)
                    const dupCheck = await client.query(`
                        SELECT id FROM transactions 
                        WHERE account_id = $1 AND amount = $2 AND description = $3 AND transaction_type = $4 
                        AND transaction_date >= $5::timestamp AND transaction_date < ($5::timestamp + interval '1 day')
                        LIMIT 1
                    `, [account_id, tr.amount, safeDescription, tr.type, txDate]);

                    // Если дубля нет — обрабатываем и сохраняем
                    // Если дубля нет — обрабатываем и сохраняем
                    if (dupCheck.rows.length === 0) {
                        let category = tr.type === 'income' ? 'Продажа продукции' : 'Закупка сырья';
                        const cpName = (tr.counterparty_name || '').toLowerCase();
                        const descLower = (tr.description || '').toLowerCase();

                        // 🚀 НОВОЕ: Сначала проверяем ЖЕСТКИЕ ПРАВИЛА (САМООБУЧЕНИЕ)
                        let ruleFound = false;
                        let overrideGroup = null;

                        if (cp_id) {
                            const ruleCheck = await client.query(`
                                SELECT target_category, target_cost_group 
                                FROM transaction_rules WHERE counterparty_id = $1 LIMIT 1
                            `, [cp_id]);

                            if (ruleCheck.rows.length > 0) {
                                category = ruleCheck.rows[0].target_category;
                                overrideGroup = ruleCheck.rows[0].target_cost_group;
                                ruleFound = true;
                            }
                        }

                        // 🚀 МАГИЯ АВТО-КАТЕГОРИЗАЦИИ ИЗ ИСТОРИИ
                        let historyCategoryFound = false;
                        if (cp_id) {
                            const lastCatCheck = await client.query(`
                                SELECT category FROM transactions 
                                WHERE counterparty_id = $1 AND category IS NOT NULL AND category != ''
                                ORDER BY transaction_date DESC LIMIT 1
                            `, [cp_id]);

                            if (lastCatCheck.rows.length > 0) {
                                category = lastCatCheck.rows[0].category;
                                historyCategoryFound = true; // Ставим флаг, что нашли в истории
                            }
                        }

                        // 🚀 ЛОГИКА "СВОЙ-ЧУЖОЙ": распознаем переводы между своими счетами
                        // (Это правило срабатывает всегда, переопределяя историю)
                        if (cpName.includes('плиттекс') ||
                            descLower.includes('собственных средств') ||
                            descLower.includes('между своими') ||
                            descLower.includes('перевод средств')) {
                            category = 'Перевод';
                        }
                        // 👇 Если история НЕ найдена, запускаем проверку по словам для расходов
                        else if (!historyCategoryFound && tr.type === 'expense') {
                            const descForCheck = descLower; // Объявляем переменную для проверки

                            if (cpName.includes('уфк') || cpName.includes('фнс') || descForCheck.includes('налог') || descForCheck.includes('енс') || descForCheck.includes('пфр') || descForCheck.includes('взносы')) category = 'Налоги, штрафы и взносы';
                            else if (descForCheck.includes('комисс') || cpName.includes('банк') || descForCheck.includes('эквайринг') || descForCheck.includes('рко')) category = 'Услуги банка и РКО';
                            else if (descForCheck.includes('аренд')) category = 'Аренда помещений';
                            else if (descForCheck.includes('займ') || descForCheck.includes('заем') || descForCheck.includes('кредит')) category = 'Возврат займов';
                            else if (descForCheck.includes('зарплат') || descForCheck.includes('аванс') || descForCheck.includes('реестр') || descForCheck.includes('оплат труда') || descForCheck.includes('ндфл')) category = 'Зарплата и Авансы';
                            else if (descForCheck.includes('доставк') || descForCheck.includes('логист') || descForCheck.includes('пэк') || descForCheck.includes('сдэк') || descForCheck.includes('деловые линии')) category = 'Транспортные расходы';
                            else if (descForCheck.includes('материал') || descForCheck.includes('сырь') || descForCheck.includes('цемент') || descForCheck.includes('песок') || descForCheck.includes('арматур') || descForCheck.includes('бетон')) category = 'Закупка сырья';
                        }
                        // 👇 Если история НЕ найдена, запускаем проверку по словам для доходов
                        else if (!historyCategoryFound && tr.type === 'income') {
                            const descForCheck = descLower; // Объявляем переменную для проверки

                            if (descForCheck.includes('займ') || descForCheck.includes('заем') || descForCheck.includes('кредит')) category = 'Получение займов';
                            else if (descForCheck.includes('возврат')) category = INCOME_REFUND_IMPREST_CATEGORY;
                        }
                        category = await resolveCategoryAlias(client, category);
                        if (tr.type === 'income') {
                            category = resolveIncomeCategoryByContext({
                                category,
                                description: safeDescription,
                                paymentMethod: 'Безналичный расчет (Импорт)'
                            });
                            await ensureIncomeCategories(client);
                        } else if (tr.type === 'expense') {
                            category = resolveExpenseCategoryByContext({
                                category,
                                description: safeDescription,
                                paymentMethod: 'Безналичный расчет (Импорт)'
                            });
                            await ensureExpenseCategories(client);
                        }
                        await ensureCategoryExists(client, category, tr.type === 'income' ? 'income' : 'expense', null, null);
                        const importTransferOverride = resolveTransferOverrideByContext({
                            description: safeDescription,
                            paymentMethod: 'Безналичный расчет (Импорт)',
                            category
                        });
                        const importTechnicalOverride = resolveTechnicalOverrideByContext({
                            category,
                            description: safeDescription,
                            paymentMethod: 'Безналичный расчет (Импорт)',
                            accountId: account_id,
                            counterpartyId: cp_id
                        });
                        if (importTransferOverride) await ensureCategoryExists(client, importTransferOverride, 'expense', 'capital', null);
                        if (importTechnicalOverride) await ensureCategoryExists(client, importTechnicalOverride, 'expense', 'capital', null);
                        await client.query(`
                            INSERT INTO transactions (amount, transaction_type, category, category_override, description, payment_method, account_id, counterparty_id, transaction_date, created_at, cost_group_override) 
                            VALUES ($1, $2, $3, $4, $5, 'Безналичный расчет (Импорт)', $6, $7, $8::timestamp, NOW(), $9)
                        `, [tr.amount, tr.type, category, importTransferOverride || importTechnicalOverride, safeDescription, account_id, cp_id, txDate, overrideGroup]);

                        // Логика автоматического закрытия выставленных счетов
                        if (tr.type === 'income') {
                            const docNumber = extractDocNumber(safeDescription);
                            if (docNumber) {
                                const invCheck = await client.query(`SELECT id, amount FROM invoices WHERE invoice_number = $1 AND status = 'pending' ORDER BY created_at ASC`, [docNumber]);
                                if (invCheck.rows.length > 0) {
                                    let remainingAmount = parseFloat(tr.amount);
                                    for (let inv of invCheck.rows) {
                                        if (remainingAmount <= 0.01) break;
                                        const invAmt = parseFloat(inv.amount);

                                        if (remainingAmount >= invAmt - 0.01) {
                                            await client.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [inv.id]);
                                            remainingAmount -= invAmt;
                                            autoPaidInvoicesCount++;
                                        } else {
                                            await client.query(`UPDATE invoices SET amount = amount - $1 WHERE id = $2`, [remainingAmount, inv.id]);
                                            remainingAmount = 0;
                                        }
                                    }
                                }
                            }
                        }
                        importedCount++;
                    }
                }
            });
            res.json({ success: true, count: importedCount, autoPaid: autoPaidInvoicesCount });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/finance/reclassify-transfer-wild', requireAdmin, async (req, res) => {
        const reason = String((req.body || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину переклассификации переводов' });
        try {
            let updated = 0;
            await withTransaction(pool, async (client) => {
                await ensureTransferCategories(client);
                const listRes = await client.query(
                    `
                    SELECT id, category, category_override, description, payment_method
                    FROM transactions
                    WHERE COALESCE(is_deleted, false) = false
                      AND LOWER(TRIM(COALESCE(category, ''))) = 'перевод'
                `
                );
                for (const tx of listRes.rows) {
                    const nextOverride = resolveTransferOverrideByContext({
                        description: tx.description,
                        paymentMethod: tx.payment_method,
                        category: tx.category_override || tx.category
                    });
                    if (!nextOverride) continue;
                    if (normalizeCategoryName(tx.category_override) === normalizeCategoryName(nextOverride)) continue;
                    await client.query('UPDATE transactions SET category_override = $1 WHERE id = $2', [nextOverride, tx.id]);
                    updated += 1;
                }
            });
            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            await auditLog(pool, req, 'finance_reclassify_transfer_wild', 'transaction', null, `updated=${updated}; reason=${reason}`);
            res.json({ success: true, updated });
        } catch (err) {
            logger.error('[API] Error in POST /api/finance/reclassify-transfer-wild:', err);
            res.status(500).json({ error: 'Не удалось переклассифицировать переводы' });
        }
    });

    router.post('/api/finance/reclassify-technical-wild', requireAdmin, async (req, res) => {
        const reason = String((req.body || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину переклассификации техопераций' });
        try {
            const stats = {
                scanned: 0,
                updated: 0,
                by_target: {}
            };
            await withTransaction(pool, async (client) => {
                await ensureTechnicalCategories(client);
                const listRes = await client.query(
                    `
                    SELECT id, category, category_override, description, payment_method, account_id, counterparty_id
                    FROM transactions
                    WHERE COALESCE(is_deleted, false) = false
                      AND (
                           LOWER(TRIM(COALESCE(category, ''))) LIKE '%техничес%операц%'
                        OR LOWER(TRIM(COALESCE(category_override, ''))) LIKE '%техничес%операц%'
                        OR LOWER(TRIM(COALESCE(category, ''))) LIKE '%тех%операц%'
                        OR LOWER(TRIM(COALESCE(category_override, ''))) LIKE '%тех%операц%'
                      )
                `
                );
                stats.scanned = listRes.rows.length;
                for (const tx of listRes.rows) {
                    const sourceCategory = tx.category_override || tx.category;
                    const target = resolveTechnicalOverrideByContext({
                        category: sourceCategory,
                        description: tx.description,
                        paymentMethod: tx.payment_method,
                        accountId: tx.account_id,
                        counterpartyId: tx.counterparty_id
                    });
                    if (!target) continue;
                    stats.by_target[target] = (stats.by_target[target] || 0) + 1;
                    if (normalizeCategoryName(tx.category_override) === normalizeCategoryName(target)) continue;
                    await client.query('UPDATE transactions SET category_override = $1 WHERE id = $2', [target, tx.id]);
                    stats.updated += 1;
                }
            });
            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            await auditLog(pool, req, 'finance_reclassify_technical_wild', 'transaction', null, `updated=${Number(stats.updated || 0)}; scanned=${Number(stats.scanned || 0)}; reason=${reason}`);
            res.json({ success: true, ...stats });
        } catch (err) {
            logger.error('[API] Error in POST /api/finance/reclassify-technical-wild:', err);
            res.status(500).json({ error: 'Не удалось переклассифицировать технические операции' });
        }
    });

    router.get('/api/finance/audit-income-categories', requireAdmin, async (req, res) => {
        try {
            const result = await pool.query(
                `
                WITH tx AS (
                    SELECT id,
                           amount,
                           description,
                           transaction_date,
                           COALESCE(NULLIF(TRIM(category_override), ''), TRIM(category)) AS eff_category
                    FROM transactions
                    WHERE COALESCE(is_deleted, false) = false
                      AND transaction_type = 'income'
                )
                SELECT tx.eff_category AS category,
                       tc.type AS dict_type,
                       COUNT(*)::int AS cnt,
                       COALESCE(SUM(tx.amount), 0)::text AS total_amount
                FROM tx
                LEFT JOIN transaction_categories tc
                  ON LOWER(TRIM(tc.name)) = LOWER(TRIM(tx.eff_category))
                WHERE tx.eff_category IS NOT NULL AND tx.eff_category <> ''
                GROUP BY tx.eff_category, tc.type
                HAVING COALESCE(tc.type, 'income') <> 'income'
                ORDER BY cnt DESC, tx.eff_category
            `
            );
            const rows = result.rows || [];
            const expected_system = [];
            const problematic = [];
            for (const r of rows) {
                if (isBidirectionalSystemCategory(r.category)) expected_system.push(r);
                else problematic.push(r);
            }
            res.json({
                success: true,
                mismatches: rows,
                problematic,
                expected_system
            });
        } catch (err) {
            logger.error('[API] Error in GET /api/finance/audit-income-categories:', err);
            res.status(500).json({ error: 'Не удалось получить аудит статей доходов' });
        }
    });

    router.post('/api/finance/reclassify-income-suspicious', requireAdmin, async (req, res) => {
        const reason = String((req.body || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину нормализации доходов' });
        try {
            const stats = { scanned: 0, updated: 0, skipped_system: 0, unchanged: 0 };
            await withTransaction(pool, async (client) => {
                await ensureIncomeCategories(client);
                const listRes = await client.query(
                    `
                    SELECT t.id, t.category, t.category_override, t.description, t.payment_method
                    FROM transactions t
                    WHERE COALESCE(t.is_deleted, false) = false
                      AND t.transaction_type = 'income'
                `
                );
                stats.scanned = listRes.rows.length;
                for (const tx of listRes.rows) {
                    const current = tx.category_override || tx.category;
                    if (isBidirectionalSystemCategory(current)) {
                        stats.skipped_system += 1;
                        continue;
                    }
                    const next = resolveIncomeCategoryByContext({
                        category: current,
                        description: tx.description,
                        paymentMethod: tx.payment_method
                    });
                    if (!next || normalizeCategoryName(next) === normalizeCategoryName(current)) {
                        stats.unchanged += 1;
                        continue;
                    }
                    await ensureCategoryExists(client, next, 'income', null, null);
                    await client.query('UPDATE transactions SET category_override = $1 WHERE id = $2', [next, tx.id]);
                    stats.updated += 1;
                }
            });
            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            await auditLog(pool, req, 'finance_reclassify_income_suspicious', 'transaction', null, `updated=${Number(stats.updated || 0)}; scanned=${Number(stats.scanned || 0)}; reason=${reason}`);
            res.json({ success: true, ...stats });
        } catch (err) {
            logger.error('[API] Error in POST /api/finance/reclassify-income-suspicious:', err);
            res.status(500).json({ error: 'Не удалось переклассифицировать доходные статьи' });
        }
    });

    router.get('/api/finance/audit-expense-categories', requireAdmin, async (req, res) => {
        try {
            const result = await pool.query(
                `
                WITH tx AS (
                    SELECT id,
                           amount,
                           description,
                           transaction_date,
                           COALESCE(NULLIF(TRIM(category_override), ''), TRIM(category)) AS eff_category
                    FROM transactions
                    WHERE COALESCE(is_deleted, false) = false
                      AND transaction_type = 'expense'
                )
                SELECT tx.eff_category AS category,
                       tc.type AS dict_type,
                       COUNT(*)::int AS cnt,
                       COALESCE(SUM(tx.amount), 0)::text AS total_amount
                FROM tx
                LEFT JOIN transaction_categories tc
                  ON LOWER(TRIM(tc.name)) = LOWER(TRIM(tx.eff_category))
                WHERE tx.eff_category IS NOT NULL AND tx.eff_category <> ''
                GROUP BY tx.eff_category, tc.type
                HAVING COALESCE(tc.type, 'expense') <> 'expense'
                ORDER BY cnt DESC, tx.eff_category
            `
            );
            const rows = result.rows || [];
            const expected_system = [];
            const problematic = [];
            for (const r of rows) {
                if (isBidirectionalSystemCategory(r.category)) expected_system.push(r);
                else problematic.push(r);
            }
            const wildRes = await pool.query(
                `
                WITH tx AS (
                    SELECT COALESCE(NULLIF(TRIM(category_override), ''), TRIM(category)) AS eff_category
                    FROM transactions
                    WHERE COALESCE(is_deleted, false) = false
                      AND transaction_type = 'expense'
                )
                SELECT eff_category AS category, COUNT(*)::int AS cnt
                FROM tx
                WHERE eff_category IS NOT NULL AND eff_category <> ''
                  AND NOT EXISTS (
                      SELECT 1 FROM transaction_categories tc
                      WHERE LOWER(TRIM(tc.name)) = LOWER(TRIM(tx.eff_category))
                  )
                GROUP BY eff_category
                ORDER BY cnt DESC, eff_category
            `
            );
            res.json({
                success: true,
                mismatches: rows,
                problematic,
                expected_system,
                wild: wildRes.rows || []
            });
        } catch (err) {
            logger.error('[API] Error in GET /api/finance/audit-expense-categories:', err);
            res.status(500).json({ error: 'Не удалось получить аудит статей расходов' });
        }
    });

    router.post('/api/finance/reclassify-expense-suspicious', requireAdmin, async (req, res) => {
        const reason = String((req.body || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину нормализации расходов' });
        try {
            const stats = { scanned: 0, updated: 0, skipped_system: 0, unchanged: 0 };
            await withTransaction(pool, async (client) => {
                await ensureExpenseCategories(client);
                const listRes = await client.query(
                    `
                    SELECT t.id, t.category, t.category_override, t.description, t.payment_method
                    FROM transactions t
                    WHERE COALESCE(t.is_deleted, false) = false
                      AND t.transaction_type = 'expense'
                `
                );
                stats.scanned = listRes.rows.length;
                for (const tx of listRes.rows) {
                    const current = tx.category_override || tx.category;
                    if (isBidirectionalSystemCategory(current)) {
                        stats.skipped_system += 1;
                        continue;
                    }
                    const next = resolveExpenseCategoryByContext({
                        category: current,
                        description: tx.description,
                        paymentMethod: tx.payment_method
                    });
                    if (!next || normalizeCategoryName(next) === normalizeCategoryName(current)) {
                        stats.unchanged += 1;
                        continue;
                    }
                    await ensureCategoryExists(client, next, 'expense', null, null);
                    await client.query('UPDATE transactions SET category_override = $1 WHERE id = $2', [next, tx.id]);
                    stats.updated += 1;
                }
            });
            const io = req.app.get('io');
            if (io) io.emit('finance_updated');
            await auditLog(pool, req, 'finance_reclassify_expense_suspicious', 'transaction', null, `updated=${Number(stats.updated || 0)}; scanned=${Number(stats.scanned || 0)}; reason=${reason}`);
            res.json({ success: true, ...stats });
        } catch (err) {
            logger.error('[API] Error in POST /api/finance/reclassify-expense-suspicious:', err);
            res.status(500).json({ error: 'Не удалось переклассифицировать расходные статьи' });
        }
    });

    // ==========================================
    // 9. ФАЙЛЫ, ЧЕКИ И АНАЛИТИКА СЕБЕСТОИМОСТИ
    // ==========================================
    if (upload) {
        router.post('/api/transactions/:id/receipt', requireAdmin, async (req, res) => {
            try {
                if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
                const fileUrl = '/uploads/' + req.file.filename;
                await pool.query('UPDATE transactions SET receipt_url = $1 WHERE id = $2', [fileUrl, req.params.id]);
                res.json({ success: true, url: fileUrl });
            } catch (err) {
                logger.error(err);
                res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.'
            }); }
        });
    }

    router.delete('/api/transactions/:id/receipt', requireAdmin, async (req, res) => {
        const reason = String((req.query || {}).reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Укажите причину удаления чека' });
        try {
            const transRes = await pool.query('SELECT receipt_url FROM transactions WHERE id = $1', [req.params.id]);
            if (transRes.rows.length > 0 && transRes.rows[0].receipt_url) {
                const filePath = path.join(__dirname, '..', 'public', transRes.rows[0].receipt_url);
                fs.unlink(filePath, (err) => {
                    if (err && err.code !== 'ENOENT') logger.error('Ошибка удаления файла:', err);
                });
            }
            await pool.query('UPDATE transactions SET receipt_url = NULL WHERE id = $1', [req.params.id]);
            await auditLog(pool, req, 'transaction_receipt_delete', 'transaction', Number(req.params.id), `reason=${reason}`);
            res.json({ success: true, message: 'Чек удален с сервера' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.'
        }); }
    });

    router.get('/api/analytics/profitability', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    o.doc_number,
                    c.name as client_name,
                    o.created_at,
                    o.total_amount as order_total,
                    -- Выручка: цена продажи × кол-во отгруженного
                    COALESCE(SUM(ABS(m.quantity) * COALESCE(coi.price, 0)), 0) as revenue,
                    -- Полная себестоимость: слепок (unit_cost_snapshot) → fallback на recipe_cost
                    COALESCE(SUM(
                        ABS(m.quantity) * COALESCE(
                            coi.unit_cost_snapshot,
                            recipe_data.recipe_cost,
                            0
                        )
                    ), 0) as material_cost
                FROM client_orders o
                JOIN counterparties c ON o.counterparty_id = c.id
                LEFT JOIN client_order_items coi ON coi.order_id = o.id
                LEFT JOIN inventory_movements m ON m.linked_order_item_id = coi.id AND m.movement_type = 'sales_shipment'
                LEFT JOIN LATERAL (
                    SELECT SUM(r.quantity_per_unit * ri_i.current_price) as recipe_cost
                    FROM recipes r
                    JOIN items ri_i ON ri_i.id = r.material_id
                    WHERE r.product_id = coi.item_id
                ) recipe_data ON true
                WHERE o.status = 'completed'
                GROUP BY o.id, o.doc_number, o.total_amount, c.name, o.created_at
                ORDER BY o.created_at DESC
                LIMIT 10
            `);

            const data = result.rows.map(row => {
                const revenue = parseFloat(row.revenue) || 0;
                const materialCost = parseFloat(row.material_cost) || 0;
                const profit = revenue - materialCost;
                const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : '0.0';
                return { ...row, revenue, profit, margin };
            });

            res.json(data);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ==========================================
    // КОНСТРУКТОР СЕБЕСТОИМОСТИ (ДЛЯ ДАШБОРДА)
    // ==========================================
    router.post('/api/analytics/cost-constructor', async (req, res) => {
        const { startDate, endDate } = req.body;
        // Даты теперь необязательны для поддержки периода "За все время"

        try {
            // 1. Считаем фактические удары пресса (циклы)
            const cyclesRes = await pool.query(`
                SELECT SUM(cycles_count) as total_cycles 
                FROM production_batches 
                WHERE 
                  (($1::timestamp IS NULL) OR (created_at >= $1::timestamp))
                  AND (($2::timestamp IS NULL) OR (created_at < ($2::timestamp + interval '1 day')))
                  AND status NOT IN ('draft', 'cancelled')
            `, [startDate || null, endDate || null]);

            const totalCycles = parseFloat(cyclesRes.rows[0].total_cycles) || 0;

            // 🚀 2. НОВОЕ: Считаем сдельную зарплату цеха из Табеля (Прямые затраты)
            // 3. Берем вႁе ႈаႁходные платежи и ႁклеиваем с МАТРИЦЕИ ႐ТАТЕИ
            const effectiveGroupSql = getEffectiveCostGroupSql('t', 'tc', 'tc_override', 'opex');
            const expensesRes = await pool.query(`
                SELECT 
                    t.id,
                    COALESCE(t.category_override, t.category) AS category,
                    t.category AS original_category,
                    t.description, 
                    t.transaction_type,
                    t.amount,
                    c.name as counterparty_name,
                    TO_CHAR(t.transaction_date, 'DD.MM.YYYY') as date,
                    t.cost_group_override,
                    ${effectiveGroupSql} as matrix_cost_group
                FROM transactions t
                LEFT JOIN transaction_categories tc ON t.category = tc.name
                LEFT JOIN transaction_categories tc_override ON t.category_override = tc_override.name
                LEFT JOIN counterparties c ON t.counterparty_id = c.id
                WHERE t.transaction_type = 'expense'
                  AND NOT (${getTransferCategoryPredicateSql('t')})
                  AND (t.is_deleted IS NULL OR t.is_deleted = false)
                  AND (($1::timestamp IS NULL) OR (t.transaction_date >= $1::timestamp))
                  AND (($2::timestamp IS NULL) OR (t.transaction_date < ($2::timestamp + interval '1 day')))
                ORDER BY t.transaction_date DESC
            `, [startDate || null, endDate || null]);

            // 4. Группируем транзакции для Drill-down
            const groupMaps = {
                direct: new Map(),
                opex: new Map(),
                capex: new Map()
            };

            let totalRawExpenses = 0;

            expensesRes.rows.forEach(t => {
                let grp = 'capex';
                let catName = t.category || 'Без категории';

                // ПРАВИЛО МАРШРУТИЗАЦИИ:
                // 1. Приоритет — ручная привязка (cost_group_override или матрица статей)
                // 2. 'Продажа продукции' + income → direct (COGS, выручка)
                // 3. Все остальные income (займы, взносы, возвраты) → capex (самопогасятся)
                // 4. Expense без группы → capex (карантин)

                const originalCategory = t.original_category || t.category;
                const mappedGroup = ensureCanonicalCostGroup(t.matrix_cost_group, 'capex');

                if (mappedGroup && ['direct', 'opex', 'capex'].includes(mappedGroup)) {
                    grp = mappedGroup;
                } else {
                    grp = 'capex';
                }

                // Финальная защита: только валидные группы
                if (!['direct', 'opex', 'capex'].includes(grp)) grp = 'capex';

                const amount = parseFloat(t.amount) || 0;
                totalRawExpenses += amount;

                if (!groupMaps[grp].has(catName)) {
                    groupMaps[grp].set(catName, {
                        name: catName,
                        total: 0,
                        transactions: []
                    });
                }

                const catObj = groupMaps[grp].get(catName);
                catObj.total += amount;
                catObj.transactions.push({
                    id: t.id,
                    description: t.description || '',
                    amount: amount,
                    date: t.date,
                    counterparty: t.counterparty_name || ''
                });
            });

            const groupedExpenses = { direct: [], opex: [], capex: [] };
            // Преобразуем Map обратно в массивы и сортируем категории по убыванию суммы
            for (const grp in groupMaps) {
                groupedExpenses[grp] = Array.from(groupMaps[grp].values()).sort((a, b) => b.total - a.total);
            }

            res.json({
                totalCycles: totalCycles,
                totalRawExpenses: totalRawExpenses, // 👈 Передаем сумму КАЖДОЙ копейки
                groupedExpenses: groupedExpenses // 👈 Новый формат для Drill-down
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ==========================================
    // 10. ПРЕДСКАЗАНИЕ КАССОВЫХ РАЗРЫВОВ (ПРОГНОЗ)
    // ==========================================
    router.get('/api/finance/cashflow-forecast', async (req, res) => {
        try {
            const accRes = await pool.query('SELECT SUM(balance) as total_balance FROM accounts');
            let currentBalance = parseFloat(accRes.rows[0].total_balance) || 0;

            const invRes = await pool.query(`
                SELECT pending_debt as amount, created_at::date + integer '3' as expected_date 
                FROM client_orders WHERE status = 'pending' OR status = 'processing'
            `);

            const expRes = await pool.query(`
                SELECT (amount - COALESCE(amount_paid, 0))::numeric AS amount, date AS expected_date
                FROM planned_expenses WHERE status = 'pending'
            `);

            const forecast = [];
            let currentBalanceBig = new Big(currentBalance);
            const runningBalanceRef = { val: currentBalanceBig };
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            for (let i = 0; i <= 30; i++) {
                const targetDate = new Date(today);
                targetDate.setDate(today.getDate() + i);
                const dateStr = targetDate.toISOString().split('T')[0];

                let dailyIncome = new Big(0);
                let dailyExpense = new Big(0);

                invRes.rows.forEach(inv => {
                    const invDateObj = new Date(inv.expected_date);
                    const invDate = invDateObj < today ? today.toISOString().split('T')[0] : invDateObj.toISOString().split('T')[0];
                    if (invDate === dateStr) dailyIncome = dailyIncome.plus(new Big(inv.amount || 0));
                });

                expRes.rows.forEach(exp => {
                    const expDateObj = new Date(exp.expected_date);
                    const expDate = expDateObj < today ? today.toISOString().split('T')[0] : expDateObj.toISOString().split('T')[0];
                    if (expDate === dateStr) dailyExpense = dailyExpense.plus(new Big(exp.amount || 0));
                });

                runningBalanceRef.val = runningBalanceRef.val.plus(dailyIncome).minus(dailyExpense);
                const runningBalance = Number(runningBalanceRef.val.toFixed(2));

                forecast.push({
                    date: dateStr,
                    income: Number(dailyIncome.toFixed(2)),
                    expense: Number(dailyExpense.toFixed(2)),
                    projected_balance: runningBalance
                });
            }

            res.json({ currentBalance, forecast });
        } catch (err) {
            logger.error('Ошибка прогноза кассовых разрывов:', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.get('/api/finance/tax-piggy-bank', async (req, res) => {
        let { start, end, usn_rate } = req.query;

        // Защита от NaN: если ставка кривая, берем 3%
        const rate = parseFloat(usn_rate);
        const usnMultiplier = (isNaN(rate) ? 3 : rate) / 100;

        if (!start || !end) {
            const currentYear = new Date().getFullYear();
            start = `${currentYear}-01-01 00:00:00`;
            end = `${currentYear}-12-31 23:59:59`;
        }

        let params = [start, end];
        let where = "WHERE COALESCE(t.is_deleted, false) = false ";
        where += `AND NOT (${getTransferCategoryPredicateSql('t')}) `;
        where += "AND t.category NOT IN ('Корректировка Баланса', 'Корректировка долга', 'Перевод', 'Ввод остатков', 'Ввод начальных остатков', 'Техническая проводка', 'Взнос учредителя', 'Получение займов') ";
        where += "AND t.transaction_date >= $1 AND t.transaction_date <= $2";

        try {
            const result = await pool.query(`
            SELECT t.*, a.type as account_type, a.name as account_name
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            ${where}
            ORDER BY t.transaction_date DESC
        `, params);

            const cashData = { transactions: [], totalTax: new Big(0), turnover: new Big(0) };
            const bankData = { transactions: [], vatIn: new Big(0), vatOut: new Big(0) };

            result.rows.forEach(t => {
                // 💎 1. Создаем объект Big сразу. parseFloat больше НЕ нужен.
                const amt = new Big(t.amount || 0);
                const descLower = (t.description || '').toLowerCase();

                // 🧠 2. Умная автоматика
                const isNoVatCat = ERP_CONFIG.noVatCategories.includes(t.category);
                const hasNoVatText = descLower.includes('без ндс') || descLower.includes('ндс не облагается');
                const hasVatText = descLower.includes('в т.ч. ндс') || descLower.includes('включая ндс');

                let autoNoVat = (isNoVatCat || hasNoVatText) && !hasVatText;

                // 🛡️ 3. Учет ручных галочек
                if (t.tax_excluded) t.is_no_vat = true;
                else if (t.tax_force_vat) t.is_no_vat = false;
                else t.is_no_vat = autoNoVat;

                if (t.account_type === 'cash') {
                    if (t.transaction_type === 'income') {
                        // Используем .times() вместо *
                        const tax = amt.times(usnMultiplier);
                        t.calculated_tax = Number(tax.toFixed(2));

                        // Используем .plus() вместо +=
                        cashData.turnover = cashData.turnover.plus(amt);
                        cashData.totalTax = cashData.totalTax.plus(tax);
                    } else {
                        t.calculated_tax = 0;
                    }
                    cashData.transactions.push(t);
                } else {
                    if (t.is_no_vat) {
                        t.calculated_tax = 0;
                    } else {
                        // 💎 4. Формула НДС через методы Big.js: amt - (amt / divider)
                        const vat = amt.times(ERP_CONFIG.vatRate).div(100 + ERP_CONFIG.vatRate);
                        t.calculated_tax = Number(vat.toFixed(2));

                        if (t.transaction_type === 'income') {
                            // Используем .plus() вместо +=
                            bankData.vatIn = bankData.vatIn.plus(vat);
                        } else {
                            bankData.vatOut = bankData.vatOut.plus(vat);
                        }
                    }
                    bankData.transactions.push(t);
                }
            });

            // 1. Сначала считаем разницу НДС как объект Big
            // bankData.vatIn и vatOut должны быть инициализированы как new Big(0) выше по коду
            const netVatBig = bankData.vatIn.minus(bankData.vatOut);

            // 2. Считаем итоговый налог (УСН + НДС если он > 0)
            // Используем netVatBig.gt(0), так как netVatBig — это объект Big.js
            const totalTaxBig = cashData.totalTax.plus(netVatBig.gt(0) ? netVatBig : new Big(0));

            // 3. Отправляем ответ, превращая всё в обычные числа только в самый последний момент
            res.json({
                summary: {
                    totalTax: Number(totalTaxBig.toFixed(2)),
                    cashTax: Number(cashData.totalTax.toFixed(2)),
                    bankVat: Number(netVatBig.toFixed(2))
                },
                cash: {
                    ...cashData,
                    totalTax: Number(cashData.totalTax.toFixed(2)),
                    turnover: Number(cashData.turnover.toFixed(2))
                },
                bank: {
                    ...bankData,
                    vatIn: Number(bankData.vatIn.toFixed(2)),
                    vatOut: Number(bankData.vatOut.toFixed(2)),
                    netVat: Number(netVatBig.toFixed(2)) // Здесь превращаем в число для фронтенда
                },
                config: {
                    vatRate: ERP_CONFIG.vatRate,
                    vatDivider: ERP_CONFIG.vatDivider
                }
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.'
        }); }
    });

    // ==========================================
    // 12. СОХРАНЕНИЕ ГАЛОЧЕК В БАЗУ (МНОГОПОЛЬЗОВАТЕЛЬСКИЙ РЕЖИМ)
    // ==========================================
    router.post('/api/finance/tax-status', requireAdmin, async (req, res) => {
        const { id, field, is_checked } = req.body;
        const allowedFields = ['tax_excluded', 'tax_force_vat'];
        if (!allowedFields.includes(field)) {
            return res.status(400).json({ error: 'Блокировка: недопустимое поле базы данных' });
        }

        try {
            await pool.query(`UPDATE transactions SET ${field} = $1 WHERE id = $2`, [is_checked, id]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    router.post('/api/finance/tax-settings', requireAdmin, async (req, res) => {
        const { key, value } = req.body;
        try {
            await pool.query(`
                INSERT INTO global_settings (setting_key, setting_value) 
                VALUES ($1, $2) 
                ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
            `, [key, value.toString()]);
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.'
        }); }
    });

    router.get('/api/finance/tax-settings', async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM global_settings');
            const settings = {};
            // Превращаем строки из таблицы в удобный объект для фронтенда
            result.rows.forEach(r => {
                settings[r.setting_key] = r.setting_value;
            });
            res.json(settings);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.'
        }); }
    });

    // --- АВТО-КАТЕГОРИЗАЦИЯ ---
    // Получаем последнюю категорию по ID контрагента
    router.get('/api/finance/last-category', async (req, res) => {
        // 1. Ловим ID контрагента из запроса
        const { counterparty_id } = req.query;
        if (!counterparty_id) return res.json({ category: null });

        try {
            // 2. Ищем последнюю не удаленную операцию с этим ID, где есть категория
            const result = await pool.query(`
            SELECT category 
            FROM transactions 
            WHERE counterparty_id = $1 
              AND category IS NOT NULL 
              AND category != ''
              AND COALESCE(is_deleted, false) = false
            ORDER BY transaction_date DESC 
            LIMIT 1
        `, [counterparty_id]);

            // 3. Возвращаем результат на фронтенд
            if (result.rows.length > 0) {
                res.json({ category: result.rows[0].category });
            } else {
                res.json({ category: null });
            }
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });


    router.get('/api/analytics/dashboard-widgets', async (req, res) => {
        try {
            // --- «Ожидаемые поступления» (дашборд) = КОНТРАКТНЫЙ долг по client_orders: Σ max(0, total_amount - paid_amount), без cancel.
            // --- «Реальные долги» в Финансах: GET /api/invoices (позиция заказа) = стоимость ОТГРУЗКИ − оплаты (см. order_line_totals там).
            // «Ожидаемые поступления» дашборда = контрактный долг: total_amount − paid_amount > 0.
            // Фильтр cp_balance намеренно убран: предоплатные клиенты (cp_balance < 0)
            // обязаны отображаться, пока есть непогашенный остаток по контракту.
            const arRes = await pool.query(`
                WITH order_contract_due AS (
                    SELECT
                        o.counterparty_id,
                        GREATEST(0, COALESCE(o.total_amount, 0) - COALESCE(o.paid_amount, 0))::numeric AS pending_debt
                    FROM client_orders o
                    WHERE o.status IS DISTINCT FROM 'cancelled'
                )
                SELECT COALESCE(SUM(ocd.pending_debt), 0)::numeric AS total_debt
                FROM order_contract_due ocd
                WHERE ocd.pending_debt > 0.005
            `);
            const totalAr = arRes.rows[0].total_debt || 0;

            const arListRes = await pool.query(`
                WITH order_contract_due AS (
                    SELECT
                        o.id,
                        o.doc_number,
                        o.counterparty_id,
                        o.created_at,
                        GREATEST(0, COALESCE(o.total_amount, 0) - COALESCE(o.paid_amount, 0))::numeric AS pending_debt
                    FROM client_orders o
                    WHERE o.status IS DISTINCT FROM 'cancelled'
                )
                SELECT
                    ocd.id,
                    ocd.doc_number,
                    c.name AS counterparty_name,
                    ocd.pending_debt,
                    TO_CHAR(ocd.created_at, 'DD.MM.YYYY') AS date,
                    ocd.created_at,
                    true AS is_order
                FROM order_contract_due ocd
                JOIN counterparties c ON ocd.counterparty_id = c.id
                WHERE ocd.pending_debt > 0.005
                ORDER BY ocd.created_at DESC
                LIMIT 5
            `);
            // 2. Умный расчет дефицита (Свободный остаток < Порог)
            // Учитываем общие остатки и вычитаем зарезервированные под заказы позиции
            const stockRes = await pool.query(`
                WITH total_stock AS (
                    -- Физический остаток (все склады)
                    SELECT item_id, SUM(quantity) as physical_qty 
                    FROM inventory_movements 
                    GROUP BY item_id
                ),
                reservations AS (
                    -- Резерв: товары, которые уже закреплены за активными заказами
                    SELECT coi.item_id, SUM(coi.qty_reserved) as reserved_qty
                    FROM client_order_items coi
                    JOIN client_orders co ON coi.order_id = co.id
                    WHERE co.status IN ('pending', 'processing')
                    GROUP BY coi.item_id
                )
                SELECT 
                    i.name, i.article, i.min_stock, i.unit,
                    COALESCE(s.physical_qty, 0) as physical_qty,
                    COALESCE(r.reserved_qty, 0) as reserved_qty,
                    (COALESCE(s.physical_qty, 0) - COALESCE(r.reserved_qty, 0)) as current_qty
                FROM items i 
                LEFT JOIN total_stock s ON i.id = s.item_id 
                LEFT JOIN reservations r ON i.id = r.item_id
                WHERE i.min_stock > 0 
                  AND (COALESCE(s.physical_qty, 0) - COALESCE(r.reserved_qty, 0)) < i.min_stock
                ORDER BY (i.min_stock - (COALESCE(s.physical_qty, 0) - COALESCE(r.reserved_qty, 0))) DESC 
                LIMIT 15
            `);

            res.json({
                ar: { total: totalAr, list: arListRes.rows },
                min_stock: stockRes.rows
            });
        } catch (err) {
            logger.error('[dashboard-widgets]', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    return router;
};