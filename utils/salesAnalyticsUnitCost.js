'use strict';

/**
 * Единая модель себестоимости единицы для «Аналитика продаж» и модалки «Себестоимость».
 * Должна совпадать с колонкой «Себестоимость ед.» (materials ± recipe hybrid + amort + overhead).
 */

function normalizeBaseName(name = '') {
    return String(name || '')
        .replace(/ 2-?й? сорт/gi, '')
        .replace(/ эксп[еи]р[еи]ментальная/gi, '')
        .replace(/ 2сорт/gi, '')
        .trim();
}

function isSecondGradeName(name = '') {
    return /2-?й?\s*сорт|эксп[еи]р[еи]ментальная|2сорт/i.test(String(name || ''));
}

/**
 * @param {import('pg').Pool} pool
 * @param {number[]} itemIds
 * @param {{ includeOverhead?: boolean, overheadPerCycle?: number }} options
 */
async function buildSalesAnalyticsUnitCostData(pool, itemIds = [], options = {}) {
    const uniqueItemIds = Array.from(new Set((itemIds || []).map((x) => Number(x || 0)).filter((x) => x > 0)));
    const includeOverhead = options.includeOverhead !== false;
    const overheadPerCycle = Number(options.overheadPerCycle || 0);
    const empty = {
        unitCostMap: new Map(),
        effectiveByRequestedId: new Map(),
        detailsByEffectiveId: new Map()
    };
    if (!uniqueItemIds.length) return empty;

    const itemsRes = await pool.query(
        `SELECT id, name, mold_id, COALESCE(qty_per_cycle, 1) AS qty_per_cycle FROM items WHERE is_deleted = false`
    );
    const allItems = itemsRes.rows || [];
    const byId = new Map(allItems.map((r) => [Number(r.id || 0), r]));
    const byName = new Map(allItems.map((r) => [String(r.name || '').trim().toLowerCase(), Number(r.id || 0)]));

    /** @type {Map<number, number>} */
    const effectiveByRequestedId = new Map();
    /** @type {Map<number, string>} */
    const modeByItem = new Map();
    for (const itemId of uniqueItemIds) {
        const row = byId.get(itemId);
        if (!row) continue;
        const name = String(row.name || '');
        if (!isSecondGradeName(name)) {
            effectiveByRequestedId.set(itemId, itemId);
            modeByItem.set(itemId, 'direct');
            continue;
        }
        const baseId = Number(byName.get(normalizeBaseName(name).toLowerCase()) || itemId);
        effectiveByRequestedId.set(itemId, baseId);
        modeByItem.set(itemId, baseId === itemId ? 'direct' : 'base');
    }

    const effectiveIds = Array.from(new Set(Array.from(effectiveByRequestedId.values()).map((x) => Number(x || 0)).filter((x) => x > 0)));
    if (!effectiveIds.length) return empty;

    const recipesRes = await pool.query(
        `
        SELECT r.product_id, r.material_id,
               COALESCE(r.quantity_per_unit, 0) AS qty_per_unit,
               COALESCE(mi.current_price, 0) AS current_price,
               mi.name AS material_name,
               COALESCE(NULLIF(TRIM(mi.unit), ''), 'ед.') AS material_unit
        FROM recipes r
        JOIN items mi ON mi.id = r.material_id
        WHERE r.product_id = ANY($1::int[])
    `,
        [effectiveIds]
    );
    /** @type {Map<number, { material_id: number, qty: number, price: number, material_name: string, material_unit: string }[]>} */
    const recipesByProduct = new Map();
    for (const r of recipesRes.rows || []) {
        const pid = Number(r.product_id || 0);
        if (!recipesByProduct.has(pid)) recipesByProduct.set(pid, []);
        recipesByProduct.get(pid).push({
            material_id: Number(r.material_id || 0),
            qty: Number(r.qty_per_unit || 0),
            price: Number(r.current_price || 0),
            material_name: r.material_name || '',
            material_unit: r.material_unit || 'ед.'
        });
    }

    const histRes = await pool.query(
        `
        SELECT id, product_id, COALESCE(planned_quantity, 0) AS planned_quantity,
               ((COALESCE(machine_amort_cost, 0) + COALESCE(mold_amort_cost, 0)) / NULLIF(COALESCE(planned_quantity, 0), 0)) AS unit_amort
        FROM (
            SELECT pb.*,
                   ROW_NUMBER() OVER (
                       PARTITION BY pb.product_id
                       ORDER BY COALESCE(pb.production_date, pb.created_at) DESC, pb.id DESC
                   ) AS rn
            FROM production_batches pb
            WHERE pb.product_id = ANY($1::int[])
              AND COALESCE(pb.status, '') = 'completed'
        ) x
        WHERE x.rn <= 10
    `,
        [effectiveIds]
    );
    /** @type {Map<number, { id: number, planned_quantity: number, unit_amort: number }[]>} */
    const batchesByProduct = new Map();
    /** @type {Map<number, number>} */
    const batchIdToProduct = new Map();
    for (const b of histRes.rows || []) {
        const pid = Number(b.product_id || 0);
        if (!batchesByProduct.has(pid)) batchesByProduct.set(pid, []);
        const obj = {
            id: Number(b.id || 0),
            planned_quantity: Number(b.planned_quantity || 0),
            unit_amort: Number(b.unit_amort || 0)
        };
        batchesByProduct.get(pid).push(obj);
        if (obj.id > 0) batchIdToProduct.set(obj.id, pid);
    }
    const allBatchIds = Array.from(batchIdToProduct.keys());
    let factRows = [];
    if (allBatchIds.length) {
        const factRes = await pool.query(
            `
            SELECT
                m.batch_id,
                m.item_id,
                MAX(i.name) AS item_name,
                MAX(COALESCE(NULLIF(TRIM(i.unit), ''), 'ед.')) AS item_unit,
                SUM(ABS(m.quantity)) AS total_fact_qty,
                SUM(ABS(m.quantity) * COALESCE(NULLIF(m.unit_price, 0), i.current_price, 0)) AS total_fact_cost
            FROM inventory_movements m
            JOIN items i ON i.id = m.item_id
            WHERE m.batch_id = ANY($1::int[])
              AND m.movement_type = 'production_expense'
            GROUP BY m.batch_id, m.item_id
        `,
            [allBatchIds]
        );
        factRows = factRes.rows || [];
    }

    const palletRes = await pool.query(`
        SELECT purchase_cost, planned_cycles
        FROM equipment
        WHERE equipment_type = 'pallets' AND status = 'active'
        ORDER BY id ASC LIMIT 1
    `);
    const palletCost = Number(palletRes.rows[0]?.purchase_cost || 0);
    const palletCycles = Number(palletRes.rows[0]?.planned_cycles || 0);

    const machineRes = await pool.query(`
        SELECT purchase_cost, planned_cycles
        FROM equipment
        WHERE equipment_type = 'machine' AND status = 'active'
        ORDER BY id ASC LIMIT 1
    `);
    const machineCost = Number(machineRes.rows[0]?.purchase_cost || 0);
    const machineCycles = Number(machineRes.rows[0]?.planned_cycles || 0);

    const moldIds = Array.from(new Set(effectiveIds.map((id) => Number(byId.get(id)?.mold_id || 0)).filter((x) => x > 0)));
    const moldMap = new Map();
    if (moldIds.length) {
        const moldRes = await pool.query(`SELECT id, purchase_cost, planned_cycles FROM equipment WHERE id = ANY($1::int[])`, [
            moldIds
        ]);
        for (const r of moldRes.rows || []) {
            moldMap.set(Number(r.id || 0), {
                purchase_cost: Number(r.purchase_cost || 0),
                planned_cycles: Number(r.planned_cycles || 0)
            });
        }
    }

    /** @type {Map<number, any>} */
    const effectiveCostDetail = new Map();
    /** @type {Map<number, { unit_cost: number, source: string, empirical: number }>} */
    const effectiveUnitRow = new Map();

    for (const pid of effectiveIds) {
        const item = byId.get(pid);
        const qtyPerCycle = Math.max(1, Number(item?.qty_per_cycle || 1));
        const overheadPerUnit =
            includeOverhead && overheadPerCycle > 0 ? overheadPerCycle / qtyPerCycle : 0;
        const recipeRows = recipesByProduct.get(pid) || [];
        /** @type {Map<number, any>} */
        const materialsMap = new Map();
        let theoretical = 0;
        for (const rr of recipeRows) {
            const mid = rr.material_id;
            const tCost = Number(rr.qty || 0) * Number(rr.price || 0);
            theoretical += tCost;
            materialsMap.set(mid, {
                id: mid,
                name: rr.material_name,
                unit: rr.material_unit,
                theory_qty: Number(rr.qty || 0),
                theory_cost: tCost,
                current_price: Number(rr.price || 0),
                fact_qty: 0,
                fact_cost: 0
            });
        }

        const batches = batchesByProduct.get(pid) || [];
        let amort = 0;
        const palletAmort = palletCycles > 0 ? palletCost / (palletCycles * qtyPerCycle) : 0;

        if (batches.length) {
            const totalProduced = batches.reduce((s, b) => s + Number(b.planned_quantity || 0), 0);
            amort =
                palletAmort + (batches.reduce((s, b) => s + Number(b.unit_amort || 0), 0) / batches.length || 0);
            if (totalProduced > 0) {
                const agg = new Map();
                for (const fr of factRows) {
                    const bid = Number(fr.batch_id || 0);
                    if (batchIdToProduct.get(bid) !== pid) continue;
                    const mid = Number(fr.item_id || 0);
                    if (!agg.has(mid)) agg.set(mid, { qty: 0, cost: 0 });
                    const cur = agg.get(mid);
                    cur.qty += Number(fr.total_fact_qty || 0);
                    cur.cost += Number(fr.total_fact_cost || 0);
                }
                for (const [mid, v] of agg.entries()) {
                    const factQty = v.qty / totalProduced;
                    const factCost = v.cost / totalProduced;
                    let rowName = '';
                    let rowUnit = 'ед.';
                    const sample = factRows.find((r) => Number(r.item_id) === mid && batchIdToProduct.get(Number(r.batch_id)) === pid);
                    if (sample) {
                        rowName = sample.item_name || '';
                        rowUnit = sample.item_unit || 'ед.';
                    }
                    if (materialsMap.has(mid)) {
                        const m = materialsMap.get(mid);
                        m.fact_qty = factQty;
                        m.fact_cost = factCost;
                    } else {
                        materialsMap.set(mid, {
                            id: mid,
                            name: rowName || `#${mid}`,
                            unit: rowUnit,
                            theory_qty: 0,
                            theory_cost: 0,
                            current_price:
                                Number(v.qty || 0) > 0 ? Number((v.cost / v.qty).toFixed(6)) : 0,
                            fact_qty: factQty,
                            fact_cost: factCost
                        });
                    }
                }
                for (const m of materialsMap.values()) {
                    if (Number(m.fact_qty || 0) === 0 && Number(m.theory_qty || 0) > 0) {
                        m.fact_qty = Number(m.theory_qty || 0);
                        m.fact_cost = Number(m.theory_cost || 0);
                        m.is_hybrid = true;
                    }
                }
            }
        } else {
            let theoryAmort = 0;
            const mold = moldMap.get(Number(item?.mold_id || 0));
            if (mold && Number(mold.planned_cycles || 0) > 0) {
                theoryAmort +=
                    Number(mold.purchase_cost || 0) / (Number(mold.planned_cycles || 0) * qtyPerCycle);
            }
            if (machineCycles > 0) {
                theoryAmort += machineCost / (machineCycles * qtyPerCycle);
            }
            amort = palletAmort + theoryAmort;
        }

        const materialsArr = Array.from(materialsMap.values()).map((m) => ({
            id: m.id,
            name: m.name,
            unit: m.unit,
            theory_qty: m.theory_qty,
            theory_cost: m.theory_cost,
            fact_qty: m.fact_qty,
            fact_cost: m.fact_cost,
            current_price: m.current_price,
            ...(m.is_hybrid ? { is_hybrid: true } : {})
        }));

        const empiricalFinal = materialsArr.reduce((s, row) => s + Number(row.fact_cost || 0), 0);
        const theoreticalFinal =
            Number(
                materialsArr.reduce((s, row) => s + Number(row.theory_cost || 0), 0).toFixed(8)
            ) || theoretical;
        const matBaseFinal = empiricalFinal > 0 ? empiricalFinal : theoreticalFinal;
        const unitCostFinal = Number((matBaseFinal + amort + overheadPerUnit).toFixed(4));

        effectiveCostDetail.set(pid, {
            theoretical: theoreticalFinal,
            empirical: empiricalFinal,
            amort,
            overheadPerUnit,
            unitCost: unitCostFinal,
            matBase: matBaseFinal,
            batchCount: batches.length,
            qtyPerCycle,
            materials: materialsArr
        });

        effectiveUnitRow.set(pid, {
            unit_cost: unitCostFinal,
            source: empiricalFinal > 0 ? 'real_batch' : theoreticalFinal > 0 ? 'recipe' : 'none',
            empirical: empiricalFinal
        });
    }

    /** @type {Map<number, { unit_cost: number, source: string }>} */
    const unitCostMap = new Map();
    for (const itemId of uniqueItemIds) {
        const row = byId.get(itemId);
        if (!row) {
            unitCostMap.set(itemId, { unit_cost: 0, source: 'none' });
            continue;
        }
        const effId = effectiveByRequestedId.get(itemId) || itemId;
        const info = effectiveUnitRow.get(effId);
        const mode = modeByItem.get(itemId) || 'direct';
        if (!info) {
            unitCostMap.set(itemId, { unit_cost: 0, source: 'none' });
            continue;
        }
        const srcBase = info.source;
        let source = 'none';
        if (srcBase === 'real_batch') source = mode === 'base' ? 'real_batch_base' : 'real_batch';
        else if (srcBase === 'recipe') source = mode === 'base' ? 'recipe_base' : 'recipe';
        unitCostMap.set(itemId, {
            unit_cost: Number(info.unit_cost || 0),
            source
        });
    }

    const detailsByEffectiveId = effectiveCostDetail;
    return {
        unitCostMap,
        effectiveByRequestedId,
        detailsByEffectiveId
    };
}

async function buildSalesAnalyticsUnitCostMap(pool, itemIds, options) {
    const { unitCostMap } = await buildSalesAnalyticsUnitCostData(pool, itemIds, options);
    return unitCostMap;
}

module.exports = {
    buildSalesAnalyticsUnitCostData,
    buildSalesAnalyticsUnitCostMap
};
