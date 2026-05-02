const { isPackagingItem } = require('./packagingMaterial');
const { calcPalletWriteoff } = require('./palletCalc');

const PALLET_RX = /(поддон|паллет|паллета)/i;

function isPalletPackaging(name, category) {
    if (!isPackagingItem(name, category)) return false;
    return PALLET_RX.test(String(name || '')) || PALLET_RX.test(String(category || ''));
}

/**
 * Оценка числа поддонов по рецептам упаковки (без учёта carry с производства — для менеджера/логистики в корзине).
 * @param {import('pg').Pool} pool
 * @param {Array<{ item_id?: number, id?: number, qty?: number|string }>} lineItems
 * @returns {Promise<{ total_pallets: number, lines: Array<{ item_id: number, qty: number, pallets: number }> }>}
 */
async function estimatePalletsFromRecipes(pool, lineItems) {
    const lines = Array.isArray(lineItems) ? lineItems : [];
    const normalized = lines
        .map((row) => {
            const itemId = Number(row.item_id ?? row.id);
            const qty = Number(row.qty);
            return { item_id: itemId, qty: Number.isFinite(qty) && qty > 0 ? qty : 0 };
        })
        .filter((row) => row.item_id > 0 && row.qty > 0);

    if (normalized.length === 0) {
        return { total_pallets: 0, lines: [] };
    }

    const mergedQty = new Map();
    for (const row of normalized) {
        mergedQty.set(row.item_id, (mergedQty.get(row.item_id) || 0) + row.qty);
    }
    const aggregated = [...mergedQty.entries()].map(([item_id, qty]) => ({ item_id, qty }));

    const uniqIds = [...mergedQty.keys()];
    const recipeRes = await pool.query(
        `
        SELECT r.product_id, r.quantity_per_unit, i.name, i.category
        FROM recipes r
        JOIN items i ON r.material_id = i.id
        WHERE r.product_id = ANY($1::int[])
    `,
        [uniqIds]
    );

    /** @type {Record<number, number[]>} product_id -> список quantity_per_unit строк «поддон» в рецепте */
    const palletPerUnitsByProduct = {};
    for (const row of recipeRes.rows) {
        if (!isPalletPackaging(row.name, row.category)) continue;
        const pid = Number(row.product_id);
        const qpu = Number(row.quantity_per_unit);
        if (!Number.isFinite(pid) || !Number.isFinite(qpu) || qpu <= 0) continue;
        if (!palletPerUnitsByProduct[pid]) palletPerUnitsByProduct[pid] = [];
        palletPerUnitsByProduct[pid].push(qpu);
    }

    let total_pallets = 0;
    const outLines = [];

    for (const { item_id, qty } of aggregated) {
        const puList = palletPerUnitsByProduct[item_id] || [];
        let pallets = 0;
        for (const pu of puList) {
            const r = calcPalletWriteoff(pu, qty, 0);
            pallets += Number(r.palletsWriteoff || 0);
        }
        total_pallets += pallets;
        outLines.push({ item_id, qty, pallets });
    }

    return { total_pallets, lines: outLines };
}

module.exports = {
    estimatePalletsFromRecipes,
    isPalletPackaging,
};
