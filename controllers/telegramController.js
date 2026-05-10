/**
 * Входящие команды Telegram-бота (long polling).
 */
const Big = require('big.js');
const logger = require('../utils/logger');
const { escapeHtml, formatMoney, NOTIFY_CB, getNotifySnapshot } = require('../utils/telegram');
const { getCounterpartyBalance } = require('../utils/counterpartyBalance');

const KB = {
    REPORTS: '📊 Отчеты',
    FINANCE: '💰 Финансы',
    WAREHOUSE: '🏗 Склад',
    REFRESH: '🔄 Обновить данные'
};

/** Штамп времени МСК для футера ответов бота */
function getFooterTime() {
    const now = new Date();
    const msk = new Date(now.getTime() + (3 * 60 * 60 * 1000) - (now.getTimezoneOffset() * 60 * 1000));
    const dd = String(msk.getUTCDate()).padStart(2, '0');
    const mm = String(msk.getUTCMonth() + 1).padStart(2, '0');
    const yy = msk.getUTCFullYear();
    const hh = String(msk.getUTCHours()).padStart(2, '0');
    const mi = String(msk.getUTCMinutes()).padStart(2, '0');
    const ss = String(msk.getUTCSeconds()).padStart(2, '0');
    return `\n\n🕒 <i>Актуально на: ${dd}.${mm}.${yy} ${hh}:${mi}:${ss}</i>`;
}

const LEGACY = {
    BALANCE: '💰 Баланс кассы',
    WAREHOUSE: '📦 Склад',
    SALES_TODAY: '📊 Отчет по продажам за сегодня'
};

const CB = {
    REPORT_SALES: 'tg:r:sales',
    REPORT_CEMENT: 'tg:r:cement',
    REPORT_ORDERS: 'tg:r:orders',
    REPORT_MENU: 'tg:r:back',

    FIN_BALANCE: 'tg:f:balance',
    FIN_MENU: 'tg:f:back',

    WH_STOCK: 'tg:w:stock',
    WH_MENU: 'tg:w:back',

    /** Повторная отправка подсказки главного Reply-меню (без сообщения нельзя «показать» клавиатуру). */
    REPLY_MAIN_REFRESH: 'tg:ui:main'
};

const SEARCH_MIN_LENGTH = 2;

function mainReplyKeyboard() {
    return {
        keyboard: [
            [KB.REPORTS, KB.FINANCE],
            [KB.WAREHOUSE, KB.REFRESH]
        ],
        resize_keyboard: true
    };
}

function mainMenuInlineFooter() {
    return [{ text: '🏠 Нижнее меню…', callback_data: CB.REPLY_MAIN_REFRESH }];
}

function reportsMenuMarkup() {
    return {
        inline_keyboard: [
            [{ text: 'Продажи за сегодня', callback_data: CB.REPORT_SALES }],
            [{ text: '📦 Склад (готовая продукция)', callback_data: CB.REPORT_CEMENT }],
            [{ text: 'Заказы в работе', callback_data: CB.REPORT_ORDERS }],
            mainMenuInlineFooter()
        ]
    };
}

function financeMenuMarkup() {
    return {
        inline_keyboard: [[{ text: 'Баланс кассы и счетов', callback_data: CB.FIN_BALANCE }], mainMenuInlineFooter()]
    };
}

function warehouseMenuMarkup() {
    return {
        inline_keyboard: [[{ text: '📦 Склад (готовая продукция)', callback_data: CB.WH_STOCK }], mainMenuInlineFooter()]
    };
}

function backToReportsRow() {
    return [{ text: '⬅️ Назад в меню отчётов', callback_data: CB.REPORT_MENU }];
}

function backToFinanceRow() {
    return [{ text: '⬅️ Назад в меню финансов', callback_data: CB.FIN_MENU }];
}

function backToWarehouseRow() {
    return [{ text: '⬅️ Назад в меню склада', callback_data: CB.WH_MENU }];
}

function notifyBackRow() {
    return [{ text: '⬅️ Назад к уведомлению', callback_data: NOTIFY_CB.NOTIFY_BACK }];
}

async function buildBalanceMessage(pool) {
    const res = await pool.query(
        `SELECT name, balance
         FROM accounts
         WHERE (
             type IN ('cash', 'bank')
             OR (
                 (type IS NULL OR TRIM(COALESCE(type::text, '')) = '')
                 AND (name ILIKE '%касса%' OR name ILIKE '%банк%')
             )
         )
           AND COALESCE(type::text, '') NOT IN ('imprest', 'accountable')
           AND name NOT ILIKE '%подотчет%'
         ORDER BY CASE WHEN type = 'cash' THEN 0 WHEN type = 'bank' THEN 1 ELSE 2 END, id ASC
         LIMIT 3`
    );
    if (res.rows.length === 0) {
        return '<b>🏦 Баланс (касса и банки)</b>\n\n<i>Нет подходящих счетов по фильтру.</i>';
    }
    let reply = '<b>🏦 Касса и банковские счета</b>\n<i>(до 3 строк)</i>\n\n';
    let total = new Big(0);
    res.rows.forEach((acc) => {
        const b = new Big(acc.balance || 0);
        reply += `🔹 ${escapeHtml(acc.name)}: <b>${formatMoney(Number(b.toFixed(2)))} ₽</b>\n`;
        total = total.plus(b);
    });
    reply += `\n<b>💵 ИТОГО: ${formatMoney(Number(total.toFixed(2)))} ₽</b>`;
    return reply;
}

/**
 * Сводка по складу готовой продукции (Единая площадка: склады finished + reserve).
 * Внутренние перемещения (reserve_expense, reserve_receipt и т.д.) исключены.
 * ТОП-15 по остатку > 0.
 */
async function buildWarehouseSummaryMessage(pool) {
    const res = await pool.query(
        `SELECT i.name, i.unit,
                SUM(m.quantity) AS stock
         FROM inventory_movements m
         JOIN items i ON m.item_id = i.id
         JOIN warehouses w ON w.id = m.warehouse_id
         WHERE w.type IN ('finished', 'reserve')
           AND m.movement_type NOT IN (
               'reserve_expense', 'reserve_receipt',
               'reserve_release_expense', 'reserve_release_receipt',
               'reserve_transfer_in', 'reserve_transfer_out'
           )
         GROUP BY i.id, i.name, i.unit
         HAVING SUM(m.quantity) > 0
         ORDER BY SUM(m.quantity) DESC
         LIMIT 15`
    );
    if (res.rows.length === 0) {
        return '📦 <b>Сводка по складу (Готовая продукция)</b>\n\n<i>Нет позиций с положительным остатком.</i>' + getFooterTime();
    }
    let reply = '<b>📦 Сводка по складу (Готовая продукция)</b>\n<i>ТОП-15 по остатку, Единая площадка</i>\n\n';
    res.rows.forEach((r) => {
        const unit = r.unit || 'шт';
        const qty = parseFloat(r.stock);
        reply += `• ${escapeHtml(r.name)}: <b>${qty % 1 === 0 ? qty.toLocaleString() : qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${escapeHtml(unit)}</b>\n`;
    });
    return reply + getFooterTime();
}

async function buildSalesTodayMessage(pool) {
    const res = await pool.query(
        `SELECT SUM(total_amount) as total, COUNT(*) as cnt FROM client_orders WHERE created_at::date = CURRENT_DATE AND status != 'cancelled' AND COALESCE(is_deleted, false) = false`
    );
    return `📈 <b>Сегодня:</b>\n\nЗаказов: ${res.rows[0]?.cnt || 0}\nСумма: ${parseFloat(res.rows[0]?.total || 0).toLocaleString()} ₽` + getFooterTime();
}

async function buildOrdersInWorkMessage(pool) {
    const res = await pool.query(
        `SELECT doc_number, status, total_amount, pending_debt, created_at
         FROM client_orders
         WHERE status IN ('pending', 'processing')
           AND COALESCE(is_deleted, false) = false
         ORDER BY created_at DESC
         LIMIT 25`
    );
    if (res.rows.length === 0) {
        return '📋 <b>Заказы в работе</b>\n\nАктивных заказов (pending / processing) нет.';
    }
    let reply = '📋 <b>Заказы в работе</b> (до 25 строк):\n\n';
    res.rows.forEach((row) => {
        reply += `• <b>${escapeHtml(row.doc_number)}</b> — ${escapeHtml(row.status)}\n`;
        reply += `  сумма ${formatMoney(row.total_amount || 0)} ₽, долг ${formatMoney(row.pending_debt || 0)} ₽\n`;
    });
    return reply + getFooterTime();
}

/**
 * Взаиморасчёт контрагента (Presentation Layer).
 * Data: getCounterpartyBalance (shared-утилита).
 * Дополнительные данные (имя, pending_debt) и форматирование — здесь.
 */
async function buildCounterpartyBalanceMessage(pool, row) {
    const cpId = row.id;
    const name = escapeHtml(row.name || '');

    const { realBalance } = await getCounterpartyBalance(pool, cpId);
    const balNum = Number(realBalance.toFixed(2));

    const debtRes = await pool.query(
        `SELECT COALESCE(SUM(pending_debt), 0) as d
         FROM client_orders
         WHERE counterparty_id = $1
           AND status NOT IN ('cancelled','returned')
           AND COALESCE(is_deleted, false) = false`,
        [cpId]
    );
    const pendNum = Number(new Big(debtRes.rows[0]?.d || 0).toFixed(2));

    return (
        `<b>👤 ${name}</b> (контрагент)\n\n` +
        `Взаиморасчёт: <b>${formatMoney(balNum)} ₽</b>\n` +
        `(${balNum >= 0 ? 'должны нам' : 'должны мы'})\n\n` +
        `Суммарный <b>pending_debt</b> по неотменённым заказам: <b>${formatMoney(pendNum)} ₽</b>` +
        getFooterTime()
    );
}

function sanitizeSearch(text) {
    return String(text)
        .replace(/\\/g, '')
        .replace(/%/g, '')
        .replace(/_/g, '')
        .trim();
}

async function lookupCounterpartyByText(pool, rawText) {
    const q = sanitizeSearch(rawText);
    if (q.length < SEARCH_MIN_LENGTH) return { kind: 'short' };

    const res = await pool.query(
        `SELECT id, name FROM counterparties
         WHERE COALESCE(is_deleted,false) = false AND name ILIKE $1
         ORDER BY LENGTH(name) ASC, name ASC LIMIT 8`,
        [`%${q}%`]
    );
    const rows = res.rows;
    if (rows.length === 0) return { kind: 'none' };
    if (rows.length > 1) {
        let m = `<b>По запросу «${escapeHtml(q)}» найдено ${rows.length} контрагента:</b>\n`;
        rows.forEach((r) => {
            m += `\n• ${escapeHtml(r.name)}`;
        });
        m += `\n\n<i>Уточните текст, чтобы остался один результат.</i>`;
        return { kind: 'many', html: m };
    }
    const html = await buildCounterpartyBalanceMessage(pool, rows[0]);
    return { kind: 'one', html };
}

/**
 * @param {import('node-telegram-bot-api')} bot
 * @param {import('pg').Pool} pool
 * @param {string|number|null|undefined} authorizedChatId
 */
module.exports = function registerTelegramMessageHandlers(bot, pool, authorizedChatId) {
    if (!bot) return;

    function authorizedChat(cid) {
        return String(cid) === String(authorizedChatId ?? '');
    }

    async function safeAnswerCallback(queryId, opts) {
        try {
            await bot.answerCallbackQuery(queryId, opts);
        } catch (e) {
            logger.warn(`[TG] answerCallbackQuery: ${e.message || e}`);
        }
    }

    async function safeEditMessageText(chatId, messageId, htmlText, markup) {
        const opts = {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            ...(markup !== undefined ? { reply_markup: markup } : {})
        };
        try {
            await bot.editMessageText(htmlText, opts);
        } catch (e) {
            const raw = `${e.response && e.response.body ? JSON.stringify(e.response.body) : ''} ${e.message || ''}`;
            if (/message is not modified|MESSAGE_NOT_MODIFIED/i.test(raw)) {
                return;
            }
            throw e;
        }
    }

    function isReservedButtonOrCommand(t) {
        if (!t) return true;
        if (t.startsWith('/')) return true;
        return (
            t === KB.REPORTS ||
            t === KB.FINANCE ||
            t === KB.WAREHOUSE ||
            t === KB.REFRESH ||
            t === LEGACY.BALANCE ||
            t === LEGACY.CEMENT ||
            t === LEGACY.SALES_TODAY
        );
    }

    bot.on('message', async (msg) => {
        const currentChatId = msg && msg.chat ? msg.chat.id : undefined;
        try {
            if (currentChatId == null || !authorizedChat(currentChatId)) return;

            const text = (msg.text || '').trim();

            if (!text || text.startsWith('/start')) {
                return bot.sendMessage(currentChatId, '👋 <b>Главное меню</b>\nВыберите раздел кнопками ниже.', {
                    parse_mode: 'HTML',
                    reply_markup: mainReplyKeyboard()
                });
            }

            if (text === KB.REPORTS) {
                return bot.sendMessage(currentChatId, '📊 <b>Отчёты</b>\nВыберите:', {
                    parse_mode: 'HTML',
                    reply_markup: reportsMenuMarkup()
                });
            }

            if (text === KB.FINANCE) {
                return bot.sendMessage(currentChatId, '💰 <b>Финансы</b>\nВыберите:', {
                    parse_mode: 'HTML',
                    reply_markup: financeMenuMarkup()
                });
            }

            if (text === KB.WAREHOUSE) {
                return bot.sendMessage(currentChatId, '🏗 <b>Склад</b>\nВыберите:', {
                    parse_mode: 'HTML',
                    reply_markup: warehouseMenuMarkup()
                });
            }

            if (text === KB.REFRESH) {
                return bot.sendMessage(currentChatId, '🔄 Меню обновлено. Нажмите кнопку раздела для свежих данных.', {
                    reply_markup: mainReplyKeyboard()
                });
            }

            if (text === LEGACY.BALANCE || text === '/balance') {
                try {
                    const reply = await buildBalanceMessage(pool);
                    return bot.sendMessage(currentChatId, reply, { parse_mode: 'HTML' });
                } catch (e) {
                    logger.warn(`[TG] balance: ${e.message || e}`);
                    return bot.sendMessage(currentChatId, '❌ Ошибка БД');
                }
            }

            if (text === LEGACY.WAREHOUSE) {
                try {
                    const reply = await buildWarehouseSummaryMessage(pool);
                    return bot.sendMessage(currentChatId, reply, { parse_mode: 'HTML' });
                } catch (e) {
                    logger.warn(`[TG] warehouse: ${e.message || e}`);
                    return bot.sendMessage(currentChatId, '❌ Ошибка');
                }
            }

            if (text === LEGACY.SALES_TODAY) {
                try {
                    const reply = await buildSalesTodayMessage(pool);
                    return bot.sendMessage(currentChatId, reply, { parse_mode: 'HTML' });
                } catch (e) {
                    logger.warn(`[TG] sales today: ${e.message || e}`);
                    return bot.sendMessage(currentChatId, '❌ Ошибка');
                }
            }

            if (!isReservedButtonOrCommand(text)) {
                try {
                    const lookup = await lookupCounterpartyByText(pool, text);
                    if (lookup.kind === 'short') {
                        return bot.sendMessage(currentChatId, '⌨️ Команда не распознана. Откройте главное меню:', {
                            reply_markup: mainReplyKeyboard()
                        });
                    }
                    if (lookup.kind === 'none') {
                        return bot.sendMessage(currentChatId, '⌨️ Команда не распознана.\n<i>Контрагент не найден.</i>', {
                            parse_mode: 'HTML',
                            reply_markup: mainReplyKeyboard()
                        });
                    }
                    if (lookup.kind === 'many') {
                        return bot.sendMessage(currentChatId, lookup.html, { parse_mode: 'HTML', reply_markup: mainReplyKeyboard() });
                    }
                    return bot.sendMessage(currentChatId, lookup.html, { parse_mode: 'HTML' });
                } catch (e) {
                    logger.warn(`[TG] lookup: ${e.message || e}`);
                    return bot.sendMessage(currentChatId, '❌ Ошибка поиска', { reply_markup: mainReplyKeyboard() });
                }
            }

            return bot.sendMessage(currentChatId, '⌨️ Команда не распознана.', {
                reply_markup: mainReplyKeyboard()
            });
        } catch (e) {
            logger.error(`[TG] message handler: ${e.message || e}`, e);
            if (currentChatId != null && authorizedChat(currentChatId)) {
                bot
                    .sendMessage(currentChatId, '❌ Внутренняя ошибка. Попробуйте позже')
                    .catch((sendErr) => logger.warn(`[TG] error reply sendMessage: ${sendErr.message || sendErr}`));
            }
        }
    });

    bot.on('callback_query', async (cq) => {
        const chatId = cq.message?.chat?.id;
        if (chatId == null || !authorizedChat(chatId)) return;
        const messageId = cq.message?.message_id;
        if (messageId == null) return;

        const data = cq.data || '';
        const qid = cq.id;

        try {
            if (data === CB.REPLY_MAIN_REFRESH) {
                await safeAnswerCallback(qid);
                await bot.sendMessage(chatId, '👋 Выберите раздел ниже 👇', {
                    parse_mode: 'HTML',
                    reply_markup: mainReplyKeyboard()
                });
                return;
            }

            if (data === CB.REPORT_MENU) {
                await safeEditMessageText(
                    chatId,
                    messageId,
                    '📊 <b>Отчёты</b>\nВыберите:',
                    reportsMenuMarkup()
                );
                await safeAnswerCallback(qid);
                return;
            }

            if (data === CB.FIN_MENU) {
                await safeEditMessageText(
                    chatId,
                    messageId,
                    '💰 <b>Финансы</b>\nВыберите:',
                    financeMenuMarkup()
                );
                await safeAnswerCallback(qid);
                return;
            }

            if (data === CB.WH_MENU) {
                await safeEditMessageText(chatId, messageId, '🏗 <b>Склад</b>\nВыберите:', warehouseMenuMarkup());
                await safeAnswerCallback(qid);
                return;
            }

            if (data === CB.REPORT_SALES || data === CB.REPORT_CEMENT || data === CB.REPORT_ORDERS) {
                const map = {
                    [CB.REPORT_SALES]: buildSalesTodayMessage,
                    [CB.REPORT_CEMENT]: buildWarehouseSummaryMessage,
                    [CB.REPORT_ORDERS]: buildOrdersInWorkMessage
                };
                const reply = await map[data](pool);
                await safeEditMessageText(chatId, messageId, reply, {
                    inline_keyboard: [backToReportsRow()]
                });
                await safeAnswerCallback(qid);
                return;
            }

            if (data === CB.FIN_BALANCE) {
                const reply = await buildBalanceMessage(pool);
                await safeEditMessageText(chatId, messageId, reply, {
                    inline_keyboard: [backToFinanceRow()]
                });
                await safeAnswerCallback(qid);
                return;
            }

            if (data === CB.WH_STOCK) {
                const reply = await buildWarehouseSummaryMessage(pool);
                await safeEditMessageText(chatId, messageId, reply, {
                    inline_keyboard: [backToWarehouseRow()]
                });
                await safeAnswerCallback(qid);
                return;
            }

            if (data === NOTIFY_CB.STOCK_SUMMARY) {
                const reply = await buildWarehouseSummaryMessage(pool);
                await safeEditMessageText(chatId, messageId, reply, {
                    inline_keyboard: [notifyBackRow()]
                });
                await safeAnswerCallback(qid);
                return;
            }

            if (data === NOTIFY_CB.ORDERS_OPEN) {
                const reply = await buildOrdersInWorkMessage(pool);
                await safeEditMessageText(chatId, messageId, reply, {
                    inline_keyboard: [notifyBackRow()]
                });
                await safeAnswerCallback(qid);
                return;
            }

            if (data === NOTIFY_CB.NOTIFY_BACK) {
                const snap = getNotifySnapshot(chatId, messageId);
                if (!snap || !snap.text) {
                    await safeEditMessageText(
                        chatId,
                        messageId,
                        '📭 <i>Исходный текст уведомления недоступен.</i>',
                        { inline_keyboard: [] }
                    );
                } else {
                    await safeEditMessageText(chatId, messageId, snap.text, snap.reply_markup || undefined);
                }
                await safeAnswerCallback(qid);
                return;
            }

            await safeAnswerCallback(qid);
        } catch (e) {
            logger.warn(`[TG] callback ${data}: ${e.message || e}`);
            await safeAnswerCallback(qid, { text: 'Ошибка', show_alert: false });
            try {
                await bot.sendMessage(chatId, '❌ Ошибка при действии.');
            } catch (_) { /* ignore */ }
        }
    });
};
