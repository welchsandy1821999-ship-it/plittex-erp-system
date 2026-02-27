const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = 3000;

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL',
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

app.use(express.static('public'));
app.use(express.json());

// ==========================================
// 1. АВТОРИЗАЦИЯ И СТАРЫЕ МАРШРУТЫ
// ==========================================
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            if (password === user.password_hash) {
                res.json({ message: 'Успех', user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name } });
            } else res.status(401).send('Неверный пароль');
        } else res.status(401).send('Пользователь не найден');
    } catch (err) { res.status(500).send('Ошибка сервера'); }
});

app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, weight_kg FROM items WHERE item_type = 'product' ORDER BY name");
        res.json(result.rows);
    } catch (err) { res.status(500).send('Ошибка сервера'); }
});

app.post('/api/sales', async (req, res) => {
    const { tileId, quantity, pricePerUnit } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const total = quantity * pricePerUnit;
        const vat = (total - (total / 1.22)).toFixed(2);

        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id) VALUES ($1, $2, 'sale', 'Отгрузка покупателю', 4)`, [tileId, -quantity]);
        await client.query(`INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method) VALUES ($1, 'income', 'Продажа плитки', 'Оплата от клиента', $2, 'Безналичный расчет')`, [total, vat]);

        await client.query('COMMIT');
        res.send('Продажа оформлена');
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send('Ошибка продажи');
    } finally { client.release(); }
});

app.get('/api/report/finance', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT category, 
                   SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) as income,
                   SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) as expense,
                   SUM(vat_amount) as total_vat
            FROM transactions GROUP BY category;
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send('Ошибка аналитики'); }
});

// ==========================================
// 8. ЗАКУПКИ И ПРИХОД СЫРЬЯ (Независимый модуль)
// ==========================================
app.post('/api/purchase', async (req, res) => {
    const { materialId, quantity, pricePerUnit, supplier } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Приходуем сырье на Склад №1
        const desc = `Приход от поставщика: ${supplier || 'Не указан'}`;
        await client.query(`
            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id)
            VALUES ($1, $2, 'purchase_receipt', $3, 1)
        `, [materialId, quantity, desc]);

        // 2. Фиксируем финансовый расход (если указана цена)
        const totalCost = quantity * pricePerUnit;
        if (totalCost > 0) {
            await client.query(`
                 INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method)
                 VALUES ($1, 'expense', 'Закупка сырья', $2, 0, 'Безналичный расчет')
        `, [totalCost, desc]);
        }

        await client.query('COMMIT');
        res.send('Сырье успешно оприходовано');
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// ==========================================
// 2. СКЛАДСКАЯ ЛОГИСТИКА И ПРОИЗВОДСТВО
// ==========================================
// === БЛОК: СКЛАД (С учетом партий) ===
app.get('/api/inventory', async (req, res) => {
    try {
        // Мы добавляем m.batch_id в SELECT и GROUP BY, чтобы видеть остатки по каждой партии отдельно
        const result = await pool.query(`
            SELECT 
                w.id as warehouse_id, 
                w.name as warehouse_name, 
                i.id as item_id, 
                i.name as item_name, 
                i.category, 
                i.unit, 
                m.batch_id, -- Видим номер партии
                SUM(m.quantity) as total
            FROM inventory_movements m
            JOIN items i ON m.item_id = i.id
            JOIN warehouses w ON m.warehouse_id = w.id
            GROUP BY w.id, w.name, i.id, i.name, i.category, i.unit, m.batch_id 
            HAVING SUM(m.quantity) != 0
            ORDER BY w.id, i.category, i.name;
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Ошибка склада:', err.message);
        res.status(500).send('Ошибка при получении данных склада');
    }
});

// ==========================================
// 6. УМНОЕ ПРОИЗВОДСТВО С ПАРТИЯМИ И СЕБЕСТОИМОСТЬЮ
// ==========================================
app.post('/api/produce', async (req, res) => {
    const { tileId, quantity, moisture = 0, defect = 0 } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Получаем рецепт И ТЕКУЩИЕ ЦЕНЫ материалов для расчета себестоимости
        const recipeRes = await client.query(`
            SELECT r.material_id, r.quantity_per_unit, i.name, i.current_price 
            FROM recipes r 
            JOIN items i ON r.material_id = i.id 
            WHERE r.product_id = $1
        `, [tileId]);

        if (recipeRes.rows.length === 0) throw new Error('Нет рецепта для продукции!');

        // 2. Генерируем номер партии (Дата + Порядковый номер за сегодня)
        const dateStr = new Date().toISOString().split('T')[0];
        const countRes = await client.query(`SELECT COUNT(*) FROM production_batches WHERE created_at::date = CURRENT_DATE`);
        const batchNum = `${dateStr}-${(parseInt(countRes.rows[0].count) + 1).toString().padStart(2, '0')}`;

        // 3. Считаем ПЛАНОВУЮ стоимость материалов на этот объем
        let totalMatCost = 0;
        const grossQuantity = quantity * (1 + (defect / 100));

        // Создаем запись о партии
        const batchRes = await client.query(`
            INSERT INTO production_batches (batch_number, product_id, planned_quantity, mat_cost_total, status)
            VALUES ($1, $2, $3, 0, 'in_drying') RETURNING id
        `, [batchNum, tileId, quantity]);
        const batchId = batchRes.rows[0].id;

        // 4. Списание материалов и накопление стоимости
        for (let ing of recipeRes.rows) {
            let needed = ing.quantity_per_unit * grossQuantity;
            if (ing.name.toLowerCase().includes('песок') && moisture > 0) {
                needed = needed / (1 - (moisture / 100));
            }

            const cost = needed * (parseFloat(ing.current_price) || 0);
            totalMatCost += cost;

            await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
                VALUES ($1, $2, 'production_expense', $3, 1, $4)
            `, [ing.material_id, -needed.toFixed(4), `Партия ${batchNum}`, batchId]);
        }

        // Обновляем итоговую стоимость материалов в партии
        await client.query(`UPDATE production_batches SET mat_cost_total = $1 WHERE id = $2`, [totalMatCost, batchId]);

        // 5. Приход в сушилку
        await client.query(`
            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
            VALUES ($1, $2, 'production_receipt', $3, 3, $4)
        `, [tileId, quantity, `Партия ${batchNum} (Сушка)`, batchId]);

        await client.query('COMMIT');
        res.json({ message: 'Партия запущена', batchNumber: batchNum });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// Умная Распалубка с закрытием партии
app.post('/api/move-wip', async (req, res) => {
    const { tileId, currentWipQty, goodQty, grade2Qty, scrapQty, isComplete, batchId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Списание из сушилки
        const totalActual = parseFloat(goodQty || 0) + parseFloat(grade2Qty || 0) + parseFloat(scrapQty || 0);
        const expenseQty = isComplete ? currentWipQty : totalActual;

        await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
                            VALUES ($1, $2, 'wip_expense', 'Выгрузка партии', 3, $3)`, [tileId, -expenseQty, batchId]);

        // 2. Приход на склады
        if (goodQty > 0) await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, warehouse_id, batch_id) VALUES ($1, $2, 'finished_receipt', 4, $3)`, [tileId, goodQty, batchId]);
        if (grade2Qty > 0) await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, warehouse_id, batch_id) VALUES ($1, $2, 'defect_receipt', 5, $3)`, [tileId, grade2Qty, batchId]);
        if (scrapQty > 0) await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, warehouse_id, batch_id) VALUES ($1, $2, 'scrap_receipt', 6, $3)`, [tileId, scrapQty, batchId]);

        // 3. ЗАКРЫВАЕМ ПАРТИЮ И ФИКСИРУЕМ ВЫХОД
        await client.query(`
            UPDATE production_batches 
            SET actual_good_qty = $1, actual_grade2_qty = $2, actual_scrap_qty = $3, status = 'completed'
            WHERE id = $4
        `, [goodQty, grade2Qty, scrapQty, batchId]);

        await client.query('COMMIT');
        res.send('Партия успешно закрыта');
    } catch (err) { await client.query('ROLLBACK'); res.status(500).send(err.message); } finally { client.release(); }
});

// МАРШРУТ ДЛЯ ГРАФИКА АНАЛИТИКИ
app.get('/api/analytics/cost-deviation', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                created_at::date as date,
                batch_number,
                -- Плановая себестоимость (на 1 ед. плана)
                (mat_cost_total / NULLIF(planned_quantity, 0)) as planned_unit_cost,
                -- Реальная себестоимость (все затраты делим только на годную плитку)
                (mat_cost_total / NULLIF(actual_good_qty, 0)) as actual_unit_cost
            FROM production_batches
            WHERE status = 'completed'
            ORDER BY created_at ASC
            LIMIT 30
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// 3. СПРАВОЧНИКИ (С серверной пагинацией)
// ==========================================
app.get('/api/items', async (req, res) => {
    const { page = 1, limit = 50, search = '', filter = 'all' } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = 'WHERE 1=1';
    let params = [];
    let paramIndex = 1;

    if (search) {
        whereClause += ` AND (name ILIKE $${paramIndex} OR category ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
    }

    if (filter === 'materials') whereClause += " AND item_type = 'material'";
    else if (filter === 'products') whereClause += " AND item_type = 'product'";
    else if (filter === 'smooth') whereClause += " AND item_type = 'product' AND name ILIKE '%Гладкая%'";
    else if (filter === 'granite') whereClause += " AND item_type = 'product' AND name ILIKE '%Гранитная%' AND name NOT ILIKE '%Меланж%'";
    else if (filter === 'melange') whereClause += " AND item_type = 'product' AND name ILIKE '%Меланж%' AND name NOT ILIKE '%Гранитная%'";
    else if (filter === 'granite_melange') whereClause += " AND item_type = 'product' AND name ILIKE '%Гранитная меланж%'";
    else if (filter === 'borders') whereClause += " AND item_type = 'product' AND category ILIKE '%Дорожные%'";
    else if (filter === 'blocks') whereClause += " AND item_type = 'product' AND category ILIKE '%Стеновые%'";

    try {
        const countRes = await pool.query(`SELECT COUNT(*) FROM items ${whereClause}`, params);
        const totalItems = parseInt(countRes.rows[0].count);
        const dataRes = await pool.query(`SELECT * FROM items ${whereClause} ORDER BY category, name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`, [...params, limit, offset]);
        res.json({ data: dataRes.rows, total: totalItems, currentPage: parseInt(page), totalPages: Math.ceil(totalItems / limit) || 1 });
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/items', async (req, res) => {
    const { name, item_type, category, unit, price, weight } = req.body;
    try {
        await pool.query(`INSERT INTO items (name, item_type, category, unit, current_price, weight_kg) VALUES ($1, $2, $3, $4, $5, $6)`, [name, item_type, category, unit, price, weight]);
        res.send('Добавлено');
    } catch (err) { res.status(500).send(err.message); }
});

app.put('/api/items/:id', async (req, res) => {
    const { name, item_type, category, unit, price, weight } = req.body;
    try {
        await pool.query(`UPDATE items SET name=$1, item_type=$2, category=$3, unit=$4, current_price=$5, weight_kg=$6 WHERE id=$7`, [name, item_type, category, unit, price, weight, req.params.id]);
        res.send('Обновлено');
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/api/items/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM items WHERE id = $1`, [req.params.id]);
        res.send('Удалено');
    } catch (err) { res.status(500).send('Товар используется на складе или в рецептах!'); }
});

// ==========================================
// 4. РЕЦЕПТУРЫ
// ==========================================
app.get('/api/recipes/:productId', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.id, r.material_id, r.quantity_per_unit, i.name as material_name, i.unit, i.current_price 
            FROM recipes r JOIN items i ON r.material_id = i.id WHERE r.product_id = $1
        `, [req.params.productId]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/recipes/save', async (req, res) => {
    const { productId, productName, ingredients, force } = req.body;
    const client = await pool.connect();
    try {
        let newSand = ingredients.find(i => i.name.toLowerCase().includes('песок'))?.qty || 0;
        let newStone = ingredients.find(i => i.name.toLowerCase().includes('щебень'))?.qty || 0;

        if (!force) {
            const match = productName.match(/(\d\.[А-Я]+\.\d)/);
            if (match) {
                const baseForm = match[0];
                const checkRes = await client.query(`
                    SELECT r.quantity_per_unit, i.name 
                    FROM recipes r JOIN items i ON r.material_id = i.id JOIN items p ON r.product_id = p.id
                    WHERE p.name LIKE $1 AND p.id != $2 AND (i.name ILIKE '%песок%' OR i.name ILIKE '%щебень%') LIMIT 10
                `, [`%${baseForm}%`, productId]);

                let oldSand = checkRes.rows.find(r => r.name.toLowerCase().includes('песок'))?.quantity_per_unit || newSand;
                let oldStone = checkRes.rows.find(r => r.name.toLowerCase().includes('щебень'))?.quantity_per_unit || newStone;

                if (Math.abs(newSand - oldSand) > oldSand * 0.1 || Math.abs(newStone - oldStone) > oldStone * 0.1) {
                    return res.status(400).json({ warning: `⚠️ ВНИМАНИЕ! Вы указали Песок: ${newSand}кг, Щебень: ${newStone}кг.\nНо у аналогичной плитки (${baseForm}) стандартом идет Песок: ${oldSand}кг, Щебень: ${oldStone}кг.\nВозможно, ошибка в данных. Сохранить принудительно?` });
                }
            }
        }

        await client.query('BEGIN');
        await client.query('DELETE FROM recipes WHERE product_id = $1', [productId]);
        for (let ing of ingredients) {
            await client.query(`INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)`, [productId, ing.materialId, ing.qty]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// ==========================================
// АВТО-СОЗДАНИЕ АДМИНИСТРАТОРА ПРИ ЗАПУСКЕ
// ==========================================
pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'employee',
        full_name VARCHAR(150)
    );
    INSERT INTO users (username, password_hash, role, full_name) 
    VALUES ('admin', '12345', 'admin', 'Директор (Администратор)')
    ON CONFLICT (username) 
    DO UPDATE SET password_hash = '12345', role = 'admin', full_name = 'Директор (Администратор)';
`).then(() => console.log('✅ База пользователей проверена. Логин: admin, Пароль: 12345'))
    .catch(err => console.error('❌ Ошибка создания пользователя:', err.message));

app.listen(port, () => {
    console.log(`🚀 ERP Плиттекс Server запущен: http://localhost:${port}`);
});