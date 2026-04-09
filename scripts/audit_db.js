require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME
});

async function audit() {
    try {
        // ========== Ревизии и Переработки для Песка ==========
        console.log('\n===== РЕВИЗИИ И ПЕРЕРАБОТКИ (Песок) =====');
        const revisions = await pool.query(
            "SELECT m.id, m.item_id, i.name as item_name, m.movement_type, m.quantity, m.amount, " +
            "m.description, m.created_at::date " +
            "FROM inventory_movements m " +
            "JOIN items i ON i.id = m.item_id " +
            "WHERE (i.name ILIKE '%песок%') " +
            "AND (m.movement_type IN ('audit', 'revision', 'adjustment', 'correction', 'sifting', 'initial', 'initial_balance') " +
            "OR m.description ILIKE '%ревизия%' " +
            "OR m.description ILIKE '%корректировка%' " +
            "OR m.description ILIKE '%просеивание%' " +
            "OR m.description ILIKE '%переработка%' " +
            "OR m.description ILIKE '%начальный%' " +
            "OR m.description ILIKE '%initial%') " +
            "ORDER BY m.created_at"
        );
        console.table(revisions.rows);

        // Суммы по ПЕСКУ
        console.log('\n===== РЕАЛЬНЫЕ ПОТОКИ ПО ПЕСКУ =====');
        const sandFlows = await pool.query(
            "SELECT i.id, i.name, " +
            "COALESCE(SUM(CASE WHEN m.quantity > 0 THEN m.quantity ELSE 0 END), 0) as total_income, " +
            "COALESCE(SUM(CASE WHEN m.quantity < 0 THEN m.quantity ELSE 0 END), 0) as total_expense, " +
            "COALESCE(SUM(m.quantity), 0) as net_balance, " +
            "COUNT(*) as movement_count " +
            "FROM inventory_movements m " +
            "JOIN items i ON i.id = m.item_id " +
            "WHERE i.name ILIKE '%песок%' " +
            "GROUP BY i.id, i.name ORDER BY i.name"
        );
        console.table(sandFlows.rows);

        // Детализация по типам
        console.log('\n===== ДЕТАЛИЗАЦИЯ ДВИЖЕНИЙ ПО ТИПАМ =====');
        const sandByType = await pool.query(
            "SELECT i.name, m.movement_type, COUNT(*) as cnt, SUM(m.quantity) as total_qty " +
            "FROM inventory_movements m " +
            "JOIN items i ON i.id = m.item_id " +
            "WHERE i.name ILIKE '%песок%' " +
            "GROUP BY i.name, m.movement_type ORDER BY i.name, m.movement_type"
        );
        console.table(sandByType.rows);

        // Пигмент белый
        console.log('\n===== ITEMS С ИМЕНЕМ ПИГМЕНТ+БЕЛЫЙ =====');
        const pgWhiteItem = await pool.query(
            "SELECT id, name, is_deleted FROM items WHERE name ILIKE '%пигмент%' AND (name ILIKE '%белый%' OR name ILIKE '%диоксид%')"
        );
        console.table(pgWhiteItem.rows);

        // Остаток Пигмент диоксид
        console.log('\n===== ОСТАТОК: ПИГМЕНТ ДИОКСИД (id=161) =====');
        const pigDiox = await pool.query(
            "SELECT i.id, i.name, COALESCE(SUM(m.quantity), 0) as current_balance " +
            "FROM items i LEFT JOIN inventory_movements m ON m.item_id = i.id " +
            "WHERE i.id = 161 " +
            "GROUP BY i.id, i.name"
        );
        console.table(pigDiox.rows);

        // Движения Пигмент диоксид детально
        console.log('\n===== ДВИЖЕНИЯ ПИГМЕНТ ДИОКСИД (id=161) =====');
        const pigDioxMoves = await pool.query(
            "SELECT m.id, m.movement_type, m.quantity, m.amount, m.description, m.created_at::date " +
            "FROM inventory_movements m WHERE m.item_id = 161 ORDER BY m.created_at"
        );
        console.table(pigDioxMoves.rows);

        // Реальные циклы (column is cycles_count)
        console.log('\n===== РЕАЛЬНЫЕ ЦИКЛЫ ИЗ ПРОИЗВОДСТВА =====');
        const realCycles = await pool.query(
            "SELECT COUNT(*) as total_batches, COALESCE(SUM(cycles_count), 0) as total_cycles FROM production_batches"
        );
        console.table(realCycles.rows);

        // Проверка: есть ли mold_id в production_batches?
        console.log('\n===== SCHEMA CHECK: mold_id в production_batches? =====');
        const hasMold = await pool.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='production_batches' AND column_name='mold_id'"
        );
        console.log('mold_id exists:', hasMold.rows.length > 0);

        // Циклы по оборудованию через items.mold_id
        console.log('\n===== ЦИКЛЫ ПО МАТРИЦАМ (через items.mold_id) =====');
        const cyclesByMold = await pool.query(
            "SELECT it.mold_id, e.name as eq_name, e.current_cycles as recorded_cycles, " +
            "COALESCE(SUM(pb.cycles_count), 0) as real_cycles, " +
            "e.current_cycles - COALESCE(SUM(pb.cycles_count), 0) as delta " +
            "FROM production_batches pb " +
            "JOIN items it ON it.id = pb.product_id " +
            "JOIN equipment e ON e.id = it.mold_id " +
            "WHERE it.mold_id IS NOT NULL " +
            "GROUP BY it.mold_id, e.name, e.current_cycles " +
            "ORDER BY it.mold_id"
        );
        console.table(cyclesByMold.rows);

        // Цены >2 знаков
        console.log('\n===== ЦЕНЫ С >2 ЗНАКОВ (movements) =====');
        const badPrices = await pool.query(
            "SELECT COUNT(*) as bad_amount_count FROM inventory_movements " +
            "WHERE amount IS NOT NULL AND amount != 0 AND amount != ROUND(amount::numeric, 2)"
        );
        console.table(badPrices.rows);

        console.log('\n===== ЦЕНЫ С >2 ЗНАКОВ (items) =====');
        const badItemP = await pool.query(
            "SELECT id, name, current_price FROM items WHERE current_price IS NOT NULL AND current_price != ROUND(current_price::numeric, 2)"
        );
        console.table(badItemP.rows);

        // Все типы движений
        console.log('\n===== СПРАВКА: ВСЕ ТИПЫ ДВИЖЕНИЙ =====');
        const moveTypes = await pool.query(
            "SELECT DISTINCT movement_type, COUNT(*) as cnt FROM inventory_movements GROUP BY movement_type ORDER BY movement_type"
        );
        console.table(moveTypes.rows);

    } catch (err) {
        console.error('ERROR:', err.message);
        console.error(err.stack);
    } finally {
        await pool.end();
    }
}

audit();
