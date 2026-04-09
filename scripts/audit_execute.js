// PHASE 2: Execute approved DB cleanup
// Blocks A + B: Sand initial balances recalculation
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME
});

async function execute() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ===== БЛОК A: Удаление ревизий и переработок песка =====
        console.log('\n===== БЛОК A: PREVIEW удаляемых записей =====');
        const preview = await client.query(
            "SELECT id, item_id, movement_type, quantity, description " +
            "FROM inventory_movements WHERE id IN (84, 842, 897, 909, 910, 912, 961, 962) ORDER BY id"
        );
        console.table(preview.rows);
        console.log(`Записей к удалению: ${preview.rows.length}`);

        const delResult = await client.query(
            "DELETE FROM inventory_movements WHERE id IN (84, 842, 897, 909, 910, 912, 961, 962)"
        );
        console.log(`✅ Удалено записей: ${delResult.rowCount}`);

        // ===== БЛОК B: Вставка правильных начальных остатков =====
        console.log('\n===== БЛОК B: Вставка начальных остатков =====');

        // Песок основной (id=155): 14 440 кг × 0.86 ₽/кг = 12 418.40 ₽
        const ins1 = await client.query(
            "INSERT INTO inventory_movements (item_id, warehouse_id, quantity, amount, movement_type, description, created_at) " +
            "VALUES (155, 1, 14440, 12418.40, 'initial', 'Начальный остаток на 01.03.2026 (пересчёт DBA-001)', '2026-03-01') " +
            "RETURNING id"
        );
        console.log(`✅ Песок основной: initial = 14 440 кг, movement_id = ${ins1.rows[0].id}`);

        // Песок лицевой (id=156): 14 300 кг × 1.00 ₽/кг = 14 300.00 ₽
        const ins2 = await client.query(
            "INSERT INTO inventory_movements (item_id, warehouse_id, quantity, amount, movement_type, description, created_at) " +
            "VALUES (156, 1, 14300, 14300.00, 'initial', 'Начальный остаток на 01.03.2026 (пересчёт DBA-001)', '2026-03-01') " +
            "RETURNING id"
        );
        console.log(`✅ Песок лицевой: initial = 14 300 кг, movement_id = ${ins2.rows[0].id}`);

        // ===== ВЕРИФИКАЦИЯ =====
        console.log('\n===== ВЕРИФИКАЦИЯ: Остатки после изменений =====');
        const verify = await client.query(
            "SELECT i.id, i.name, COALESCE(SUM(m.quantity), 0) as balance " +
            "FROM items i LEFT JOIN inventory_movements m ON m.item_id = i.id " +
            "WHERE i.id IN (155, 156) GROUP BY i.id, i.name ORDER BY i.name"
        );
        console.table(verify.rows);

        // Детализация потоков
        console.log('\n===== ВЕРИФИКАЦИЯ: Детализация по типам =====');
        const verifyDetail = await client.query(
            "SELECT i.name, m.movement_type, COUNT(*) as cnt, SUM(m.quantity) as total " +
            "FROM inventory_movements m JOIN items i ON i.id = m.item_id " +
            "WHERE i.id IN (155, 156) GROUP BY i.name, m.movement_type ORDER BY i.name, m.movement_type"
        );
        console.table(verifyDetail.rows);

        await client.query('COMMIT');
        console.log('\n🎉 ТРАНЗАКЦИЯ ПОДТВЕРЖДЕНА (COMMIT)');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ ROLLBACK:', err.message);
        console.error(err.stack);
    } finally {
        client.release();
        await pool.end();
    }
}

execute();
