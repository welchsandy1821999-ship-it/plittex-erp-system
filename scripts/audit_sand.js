require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME
});

async function audit() {
    try {
        // Ревизии и Переработки для Песка
        console.log('\n===== РЕВИЗИИ И ПЕРЕРАБОТКИ (Песок) =====');
        const revisions = await pool.query(
            "SELECT m.id, m.item_id, i.name as item_name, m.movement_type, m.quantity, " +
            "m.description, m.created_at::date " +
            "FROM inventory_movements m " +
            "JOIN items i ON i.id = m.item_id " +
            "WHERE (i.name ILIKE '%песок%') " +
            "AND (m.movement_type IN ('audit_adjustment', 'initial', 'sifting_expense', 'sifting_receipt', 'ревизия') " +
            "OR m.description ILIKE '%просеивание%' " +
            "OR m.description ILIKE '%переработка%' " +
            "OR m.description ILIKE '%начальный%' " +
            "OR m.description ILIKE '%корректир%') " +
            "ORDER BY m.created_at"
        );
        revisions.rows.forEach(r => console.log(JSON.stringify(r)));

        // Суммы по ПЕСКУ - только закупки
        console.log('\n===== ЗАКУПКИ ПЕСКА =====');
        const sandPurchases = await pool.query(
            "SELECT i.name, SUM(m.quantity) as purchase_qty " +
            "FROM inventory_movements m " +
            "JOIN items i ON i.id = m.item_id " +
            "WHERE i.name ILIKE '%песок%' AND m.movement_type = 'purchase' " +
            "GROUP BY i.name ORDER BY i.name"
        );
        console.table(sandPurchases.rows);

        // Расход на производство
        console.log('\n===== РАСХОД ПЕСКА НА ПРОИЗВОДСТВО =====');
        const sandProd = await pool.query(
            "SELECT i.name, SUM(m.quantity) as prod_expense_qty " +
            "FROM inventory_movements m " +
            "JOIN items i ON i.id = m.item_id " +
            "WHERE i.name ILIKE '%песок%' AND m.movement_type = 'production_expense' " +
            "GROUP BY i.name ORDER BY i.name"
        );
        console.table(sandProd.rows);

        // Все потоки по песку суммарно
        console.log('\n===== ВСЕ ПОТОКИ ПО ПЕСКУ =====');
        const sandAll = await pool.query(
            "SELECT i.id, i.name, " +
            "COALESCE(SUM(CASE WHEN m.quantity > 0 THEN m.quantity ELSE 0 END), 0) as total_in, " +
            "COALESCE(SUM(CASE WHEN m.quantity < 0 THEN m.quantity ELSE 0 END), 0) as total_out, " +
            "COALESCE(SUM(m.quantity), 0) as balance " +
            "FROM inventory_movements m " +
            "JOIN items i ON i.id = m.item_id " +
            "WHERE i.name ILIKE '%песок%' GROUP BY i.id, i.name ORDER BY i.name"
        );
        console.table(sandAll.rows);

        // Суммы по песку только "чистые" (закупки + производство, без ревизий)
        console.log('\n===== ЧИСТЫЕ ПОТОКИ (без ревизий/начальных) =====');
        const sandClean = await pool.query(
            "SELECT i.id, i.name, " +
            "COALESCE(SUM(CASE WHEN m.quantity > 0 THEN m.quantity ELSE 0 END), 0) as clean_in, " +
            "COALESCE(SUM(CASE WHEN m.quantity < 0 THEN m.quantity ELSE 0 END), 0) as clean_out " +
            "FROM inventory_movements m " +
            "JOIN items i ON i.id = m.item_id " +
            "WHERE i.name ILIKE '%песок%' " +
            "AND m.movement_type NOT IN ('initial', 'audit_adjustment', 'ревизия', 'sifting_expense', 'sifting_receipt') " +
            "GROUP BY i.id, i.name ORDER BY i.name"
        );
        console.table(sandClean.rows);

    } catch (err) {
        console.error('ERROR:', err.message);
    } finally {
        await pool.end();
    }
}
audit();
