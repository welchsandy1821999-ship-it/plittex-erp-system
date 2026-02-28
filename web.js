const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = 3000;

// Указываем, что используем шаблонизатор EJS
app.set('view engine', 'ejs');
app.set('views', './views');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL',
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

app.use(express.static('public'));
app.use(express.json());
//ЭТОТ МАРШРУТ (Отдача главной страницы)
app.get('/', (req, res) => {
    res.render('index');
});

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
        const result = await pool.query("SELECT id, name, category, weight_kg FROM items WHERE item_type = 'product' ORDER BY category, name");
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

// === web.js: Управление замесами ===

// 1. Получение дефолтных норм замесов (из БД)
app.get('/api/mix-templates', async (req, res) => {
    try {
        const result = await pool.query(`SELECT value FROM settings WHERE key = 'mix_templates'`);
        if (result.rows.length > 0) res.json(result.rows[0].value);
        else res.json({ big: [], small: [] });
    } catch (err) { res.status(500).send(err.message); }
});

// Сохранение обновленных норм замесов
app.post('/api/mix-templates', async (req, res) => {
    try {
        await pool.query(`
            INSERT INTO settings (key, value) VALUES ('mix_templates', $1)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// СОХРАНЕНИЕ ФОРМОВКИ ЗА ДЕНЬ (С УНИКАЛЬНЫМИ ПАРТИЯМИ И ПРОПОРЦИЯМИ)
// ==========================================
app.post('/api/production/daily', async (req, res) => {
    const { date, bigMixes, smallMixes, products } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Собираем всё сырье и находим его цены в базе
        const allMaterials = [...(bigMixes || []), ...(smallMixes || [])].filter(m => m.qty > 0);
        const matDetails = [];

        for (let mat of allMaterials) {
            const itemRes = await client.query(`SELECT id, current_price FROM items WHERE name = $1 LIMIT 1`, [mat.name]);
            if (itemRes.rows.length > 0) {
                matDetails.push({
                    id: itemRes.rows[0].id,
                    name: mat.name,
                    qty: mat.qty,
                    price: parseFloat(itemRes.rows[0].current_price) || 0
                });
            }
        }

        const totalMaterialCost = matDetails.reduce((sum, m) => sum + (m.qty * m.price), 0);
        const totalProductsQty = products.reduce((sum, p) => sum + parseFloat(p.qty), 0);

        // 2. Узнаем, сколько партий УЖЕ БЫЛО создано в этот день (для уникальных номеров)
        const countRes = await client.query(`SELECT COUNT(*) FROM production_batches WHERE created_at::date = $1`, [date]);
        let batchCounter = parseInt(countRes.rows[0].count);

        // 3. Распределяем материалы пропорционально объему каждой плитки
        for (let p of products) {
            const qty = parseFloat(p.qty);
            if (qty <= 0) continue;

            batchCounter++; // Увеличиваем номер партии
            const batchNum = `${date}-СМЕНА-${batchCounter.toString().padStart(2, '0')}`;

            // Считаем долю этой плитки от общего объема смены
            const fraction = totalProductsQty > 0 ? (qty / totalProductsQty) : 0;
            const batchCost = totalMaterialCost * fraction;

            // Создаем партию
            const batchRes = await client.query(`
                INSERT INTO production_batches (batch_number, product_id, planned_quantity, mat_cost_total, status, created_at)
                VALUES ($1, $2, $3, $4, 'in_drying', $5) RETURNING id
            `, [batchNum, p.id, qty, batchCost, date]);
            const batchId = batchRes.rows[0].id;

            // Списываем сырье ИМЕННО НА ЭТУ ПАРТИЮ (умножаем на fraction)
            for (let m of matDetails) {
                const matQtyForBatch = m.qty * fraction;
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, created_at)
                    VALUES ($1, $2, 'production_expense', $3, 1, $4, $5)
                `, [m.id, -matQtyForBatch, `Сырье на ${batchNum}`, batchId, date]);
            }

            // Отправляем плитку в сушилку
            await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, created_at)
                VALUES ($1, $2, 'production_receipt', $3, 3, $4, $5)
            `, [p.id, qty, `Формовка ${batchNum}`, batchId, date]);
        }

        await client.query('COMMIT');
        res.send('Формовка успешно сохранена!');
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// ==========================================
// ПОЛУЧЕНИЕ ИСТОРИИ ПАРТИЙ ЗА ДЕНЬ
// ==========================================
app.get('/api/production/history', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT pb.id, pb.batch_number, i.name as product_name, pb.planned_quantity, pb.mat_cost_total, pb.created_at
            FROM production_batches pb
            JOIN items i ON pb.product_id = i.id
            WHERE pb.created_at::date = $1
            ORDER BY pb.id DESC
        `, [req.query.date]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// ОТМЕНА (УДАЛЕНИЕ) ФОРМОВКИ И ВОЗВРАТ МАТЕРИАЛОВ
// ==========================================
app.delete('/api/production/batch/:id', async (req, res) => {
    const batchId = req.params.id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Удаляем все движения по складам (сырье возвращается на Склад 1, плитка исчезает из Склада 3)
        await client.query('DELETE FROM inventory_movements WHERE batch_id = $1', [batchId]);

        // 2. Удаляем саму партию
        await client.query('DELETE FROM production_batches WHERE id = $1', [batchId]);

        await client.query('COMMIT');
        res.send('Формовка отменена, материалы возвращены на склад');
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// ==========================================
// ДЕТАЛИЗАЦИЯ СЫРЬЯ ПО КОНКРЕТНОЙ ПАРТИИ (С ГРУППИРОВКОЙ)
// ==========================================
app.get('/api/production/batch/:id/materials', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT i.name, 
                   SUM(ABS(m.quantity)) as qty, 
                   i.unit, 
                   SUM(ABS(m.quantity) * i.current_price) as cost,
                   pb.planned_quantity
            FROM inventory_movements m
            JOIN items i ON m.item_id = i.id
            JOIN production_batches pb ON m.batch_id = pb.id
            WHERE m.batch_id = $1 AND m.movement_type = 'production_expense'
            GROUP BY i.name, i.unit, pb.planned_quantity
            ORDER BY cost DESC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
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
        const result = await pool.query(`
            SELECT 
                w.id as warehouse_id, 
                w.name as warehouse_name, 
                i.id as item_id, 
                i.name as item_name, 
                i.category, 
                i.unit, 
                m.batch_id, 
                pb.batch_number, -- Подтягиваем красивый номер партии
                SUM(m.quantity) as total
            FROM inventory_movements m
            JOIN items i ON m.item_id = i.id
            JOIN warehouses w ON m.warehouse_id = w.id
            LEFT JOIN production_batches pb ON m.batch_id = pb.id
            GROUP BY w.id, w.name, i.id, i.name, i.category, i.unit, m.batch_id, pb.batch_number
            HAVING SUM(m.quantity) != 0
            ORDER BY w.id, i.category, i.name;
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send('Ошибка склада'); }
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

// Получить партии в сушилке (для распалубки)
app.get('/api/production/in-drying', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT pb.id, pb.batch_number, pb.product_id, i.name as product_name, pb.planned_quantity, pb.created_at
            FROM production_batches pb
            JOIN items i ON pb.product_id = i.id
            WHERE pb.status = 'in_drying'
            ORDER BY pb.created_at ASC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Умная Распалубка с закрытием партии
app.post('/api/move-wip', async (req, res) => {
    const { tileId, currentWipQty, goodQty, grade2Qty, scrapQty, isComplete, batchId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const totalActual = parseFloat(goodQty || 0) + parseFloat(grade2Qty || 0) + parseFloat(scrapQty || 0);

        // ЛОГИКА ЗАКРЫТИЯ: закрываем, если стоит галочка ИЛИ если по факту вытащили всё, что числилось
        const finalIsComplete = isComplete || (totalActual >= parseFloat(currentWipQty));

        // Если закрываем полностью, списываем из сушилки ВЕСЬ числящийся остаток (чтобы не было пустых хвостов).
        // Но если получилось больше плана, списываем фактическое количество.
        const expenseQty = finalIsComplete ? Math.max(parseFloat(currentWipQty), totalActual) : totalActual;

        if (expenseQty > 0) {
            await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id) 
                                VALUES ($1, $2, 'wip_expense', 'Выгрузка партии', 3, $3)`, [tileId, -expenseQty, batchId]);
        }

        // 2. Приход на склады
        if (parseFloat(goodQty) > 0) await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, warehouse_id, batch_id) VALUES ($1, $2, 'finished_receipt', 4, $3)`, [tileId, goodQty, batchId]);
        if (parseFloat(grade2Qty) > 0) await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, warehouse_id, batch_id) VALUES ($1, $2, 'defect_receipt', 5, $3)`, [tileId, grade2Qty, batchId]);
        if (parseFloat(scrapQty) > 0) await client.query(`INSERT INTO inventory_movements (item_id, quantity, movement_type, warehouse_id, batch_id) VALUES ($1, $2, 'scrap_receipt', 6, $3)`, [tileId, scrapQty, batchId]);

        // 3. ЗАКРЫВАЕМ ПАРТИЮ И ФИКСИРУЕМ ВЫХОД
        const status = finalIsComplete ? 'completed' : 'in_drying';

        await client.query(`
            UPDATE production_batches 
            SET actual_good_qty = COALESCE(actual_good_qty, 0) + $1, 
                actual_grade2_qty = COALESCE(actual_grade2_qty, 0) + $2, 
                actual_scrap_qty = COALESCE(actual_scrap_qty, 0) + $3, 
                status = $4
            WHERE id = $5
        `, [goodQty, grade2Qty, scrapQty, status, batchId]);

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
// 3. СПРАВОЧНИКИ (Умный поиск и фильтрация)
// ==========================================

// Получение списка уникальных категорий для фильтров
app.get('/api/categories', async (req, res) => {
    try {
        const result = await pool.query(`SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category != '' ORDER BY category`);
        res.json(result.rows.map(r => r.category));
    } catch (err) { res.status(500).send(err.message); }
});

// Умный поиск и получение товаров
app.get('/api/items', async (req, res) => {
    const { page = 1, limit = 50, search = '', item_type = '', category = '' } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    let params = [];
    let paramIndex = 1;

    // Фильтр по тексту (Название или Категория)
    if (search) {
        whereClause += ` AND (name ILIKE $${paramIndex} OR category ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
    }
    // Фильтр по типу (Сырье / Продукция)
    if (item_type) {
        whereClause += ` AND item_type = $${paramIndex}`;
        params.push(item_type);
        paramIndex++;
    }
    // Фильтр по конкретной категории
    if (category) {
        whereClause += ` AND category = $${paramIndex}`;
        params.push(category);
        paramIndex++;
    }

    try {
        const countRes = await pool.query(`SELECT COUNT(*) FROM items ${whereClause}`, params);
        const totalItems = parseInt(countRes.rows[0].count);
        // Выводим с сортировкой: сначала Тип, затем Категория, затем Алфавит
        const dataRes = await pool.query(`SELECT * FROM items ${whereClause} ORDER BY item_type, category, name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`, [...params, limit, offset]);

        res.json({
            data: dataRes.rows,
            total: totalItems,
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalItems / limit) || 1
        });
    } catch (err) { res.status(500).send(err.message); }
});

// Добавление новой позиции
app.post('/api/items', async (req, res) => {
    const { name, item_type, category, unit, price, weight } = req.body;
    try {
        await pool.query(`INSERT INTO items (name, item_type, category, unit, current_price, weight_kg) VALUES ($1, $2, $3, $4, $5, $6)`, [name, item_type, category, unit, price, weight]);
        res.send('Добавлено');
    } catch (err) { res.status(500).send(err.message); }
});

// Обновление существующей позиции
app.put('/api/items/:id', async (req, res) => {
    const { name, item_type, category, unit, price, weight } = req.body;
    try {
        await pool.query(`UPDATE items SET name=$1, item_type=$2, category=$3, unit=$4, current_price=$5, weight_kg=$6 WHERE id=$7`, [name, item_type, category, unit, price, weight, req.params.id]);
        res.send('Обновлено');
    } catch (err) { res.status(500).send(err.message); }
});

// Удаление позиции
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
// МАССОВОЕ КОПИРОВАНИЕ РЕЦЕПТА (ШАБЛОНЫ)
// ==========================================
app.post('/api/recipes/mass-copy', async (req, res) => {
    const { sourceProductId, targetProductIds } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Получаем эталонный рецепт
        const sourceRecipeRes = await client.query(`SELECT material_id, quantity_per_unit FROM recipes WHERE product_id = $1`, [sourceProductId]);
        const sourceRecipe = sourceRecipeRes.rows;

        if (sourceRecipe.length === 0) throw new Error('Эталонный рецепт пуст!');

        // 2. Применяем ко всем целевым товарам
        for (let targetId of targetProductIds) {
            // Удаляем старый рецепт у цели
            await client.query('DELETE FROM recipes WHERE product_id = $1', [targetId]);

            // Вставляем копию эталона
            for (let ing of sourceRecipe) {
                await client.query(`
                    INSERT INTO recipes (product_id, material_id, quantity_per_unit) 
                    VALUES ($1, $2, $3)
                `, [targetId, ing.material_id, ing.quantity_per_unit]);
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, message: `Шаблон применен к ${targetProductIds.length} позициям.` });
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

// ==========================================
// УМНАЯ СИНХРОНИЗАЦИЯ РЕЦЕПТОВ ПО ВЫБРАННЫМ ID
// ==========================================
app.post('/api/recipes/sync-category', async (req, res) => {
    // Теперь принимаем конкретные ID товаров (targetProductIds)
    const { targetProductIds, materials } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        if (!targetProductIds || targetProductIds.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ message: 'Не выбраны товары для синхронизации.' });
        }

        // Обновляем базовые материалы для каждого выбранного товара
        for (let targetId of targetProductIds) {
            for (let mat of materials) {
                const checkRes = await client.query(
                    `SELECT 1 FROM recipes WHERE product_id = $1 AND material_id = $2`,
                    [targetId, mat.materialId]
                );

                if (checkRes.rows.length > 0) {
                    await client.query(
                        `UPDATE recipes SET quantity_per_unit = $1 WHERE product_id = $2 AND material_id = $3`,
                        [mat.qty, targetId, mat.materialId]
                    );
                } else {
                    await client.query(
                        `INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)`,
                        [targetId, mat.materialId, mat.qty]
                    );
                }
            }
        }

        await client.query('COMMIT');
        res.json({ message: `Успешно применено к ${targetProductIds.length} позициям.` });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally {
        client.release();
    }
});

// ==========================================
// 9. КАДРЫ, ТАБЕЛЬ И ЗАРПЛАТА
// ==========================================

// Получить список всех сотрудников
app.get('/api/employees', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM employees ORDER BY department, full_name`);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Добавить сотрудника
app.post('/api/employees', async (req, res) => {
    const { full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status } = req.body;
    try {
        await pool.query(`
            INSERT INTO employees (full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [full_name, position, department, schedule_type, salary_cash || 0, salary_official || 20000, tax_rate || 13, tax_withheld || 2600, prev_balance || 0, status || 'active']);
        res.send('Сотрудник добавлен');
    } catch (err) { res.status(500).send(err.message); }
});

// Обновить сотрудника (с защитой прошлых месяцев и остатком)
app.put('/api/employees/:id', async (req, res) => {
    const { full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status } = req.body;
    const currentMonthStr = new Date().toISOString().substring(0, 7);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            UPDATE employees SET full_name=$1, position=$2, department=$3, schedule_type=$4, salary_cash=$5, salary_official=$6, tax_rate=$7, tax_withheld=$8, prev_balance=$9, status=$10
            WHERE id=$11
        `, [full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status, req.params.id]);

        await client.query(`
            UPDATE monthly_salary_stats 
            SET salary_cash=$1, salary_official=$2, tax_rate=$3, tax_withheld=$4
            WHERE employee_id=$5 AND month_str >= $6
        `, [salary_cash, salary_official, tax_rate, tax_withheld, req.params.id, currentMonthStr]);

        await client.query('COMMIT');
        res.send('Данные обновлены');
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// === ДОП. ОПЕРАЦИИ (ГСМ, ЗАЙМЫ, ШТРАФЫ И БОНУСЫ) ===
app.get('/api/salary/adjustments', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM salary_adjustments WHERE month_str = $1`, [req.query.monthStr]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/salary/adjustments', async (req, res) => {
    const { employee_id, month_str, amount, description } = req.body;
    try {
        await pool.query(`INSERT INTO salary_adjustments (employee_id, month_str, amount, description) VALUES ($1, $2, $3, $4)`, [employee_id, month_str, amount, description]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/api/salary/adjustments/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM salary_adjustments WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// Получить "слепки" окладов на конкретный месяц (Авто-создание если их нет)
app.get('/api/salary/stats', async (req, res) => {
    const { year, month } = req.query;
    const monthStr = `${year}-${month}`;
    try {
        // Если мы впервые открываем этот месяц, копируем текущие оклады из профиля сотрудников
        await pool.query(`
            INSERT INTO monthly_salary_stats (employee_id, month_str, salary_cash, salary_official, tax_rate, tax_withheld)
            SELECT id, $1, salary_cash, salary_official, tax_rate, tax_withheld FROM employees
            ON CONFLICT (employee_id, month_str) DO NOTHING
        `, [monthStr]);

        const result = await pool.query(`SELECT * FROM monthly_salary_stats WHERE month_str = $1`, [monthStr]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Оплата официальных налогов по безналу
app.post('/api/salary/pay-taxes', async (req, res) => {
    const { monthStr, amount } = req.body;
    try {
        await pool.query(`
            INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method)
            VALUES ($1, 'expense', 'Налоги и Взносы', $2, 0, 'Безналичный расчет')
        `, [amount, `Уплата налогов с ФОТ за ${monthStr}`]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// Получить табель на конкретную дату
app.get('/api/timesheet', async (req, res) => {
    const { date } = req.query;
    try {
        // Вытягиваем всех сотрудников и их отметки на этот день (если они есть)
        const result = await pool.query(`
            SELECT e.id as employee_id, e.full_name, e.position, e.department, e.schedule_type, t.status 
            FROM employees e
            LEFT JOIN timesheets t ON e.id = t.employee_id AND t.record_date = $1
            ORDER BY e.department, e.full_name
        `, [date]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Сохранить табель за день
app.post('/api/timesheet', async (req, res) => {
    const { date, records } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let rec of records) {
            // Используем UPSERT (вставить или обновить, если уже есть отметка на этот день)
            await client.query(`
                INSERT INTO timesheets (employee_id, record_date, status)
                VALUES ($1, $2, $3)
                ON CONFLICT (employee_id, record_date) 
                DO UPDATE SET status = EXCLUDED.status
            `, [rec.employee_id, date, rec.status]);
        }
        await client.query('COMMIT');
        res.json({ message: 'Табель успешно сохранен!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// Получить табель на ВЕСЬ МЕСЯЦ (с деньгами)
app.get('/api/timesheet/month', async (req, res) => {
    const { year, month } = req.query;
    try {
        const startDate = `${year}-${month}-01`;
        const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`; // ЖЕЛЕЗОБЕТОННАЯ ДАТА

        // ИСПОЛЬЗУЕМ TO_CHAR ДЛЯ ЗАЩИТЫ ОТ СДВИГА ЧАСОВЫХ ПОЯСОВ
        const result = await pool.query(`
            SELECT employee_id, TO_CHAR(record_date, 'YYYY-MM-DD') as record_date, status, bonus, penalty
            FROM timesheets
            WHERE record_date >= $1 AND record_date <= $2
        `, [startDate, endDate]);

        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Быстрое сохранение статуса одной ячейки (с премией и штрафом)
app.post('/api/timesheet/cell', async (req, res) => {
    const { employee_id, date, status, bonus, penalty } = req.body;
    try {
        await pool.query(`
            INSERT INTO timesheets (employee_id, record_date, status, bonus, penalty)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (employee_id, record_date) 
            DO UPDATE SET status = EXCLUDED.status, bonus = EXCLUDED.bonus, penalty = EXCLUDED.penalty
        `, [employee_id, date, status, bonus || 0, penalty || 0]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

// ==========================================
// ИНТЕГРАЦИЯ: ПРОИЗВОДСТВО -> ЗАРПЛАТА (СДЕЛЬНАЯ)
// ==========================================

// Получить статистику производства (Годная продукция) за конкретный день
app.get('/api/production/daily-stats', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT SUM(actual_good_qty) as total_good 
            FROM production_batches 
            WHERE created_at::date = $1 AND status = 'completed'
        `, [req.query.date]);
        res.json({ total: result.rows[0].total_good || 0 });
    } catch (err) { res.status(500).send(err.message); }
});

// Массовое начисление сдельной премии выбранным сотрудникам
app.post('/api/timesheet/mass-bonus', async (req, res) => {
    const { date, empIds, bonusPerPerson } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let id of empIds) {
            // Если отметка в табеле уже есть — прибавляем премию. 
            // Если отметки нет (забыли поставить) — ставим "Был" и начисляем.
            await client.query(`
                INSERT INTO timesheets (employee_id, record_date, status, bonus)
                VALUES ($1, $2, 'present', $3)
                ON CONFLICT (employee_id, record_date) 
                DO UPDATE SET bonus = timesheets.bonus + EXCLUDED.bonus
            `, [id, date, bonusPerPerson]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// Получить все выплаты (авансы) за выбранный месяц (с детализацией)
app.get('/api/salary/payments', async (req, res) => {
    const { year, month } = req.query;
    try {
        const startDate = `${year}-${month}-01`;
        const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;

        const result = await pool.query(`
            SELECT id, employee_id, amount, TO_CHAR(payment_date, 'YYYY-MM-DD') as payment_date, description
            FROM salary_payments
            WHERE payment_date >= $1 AND payment_date <= $2
            ORDER BY payment_date ASC
        `, [startDate, endDate]);

        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});
// Выдать аванс/зарплату
app.post('/api/salary/pay', async (req, res) => {
    const { employee_id, amount, date, description } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Фиксируем выплату в модуле зарплат
        await client.query(`
            INSERT INTO salary_payments (employee_id, amount, payment_date, description)
            VALUES ($1, $2, $3, $4)
        `, [employee_id, amount, date, description]);

        // 2. Списываем деньги из общей кассы предприятия (как Наличные) с нулевым НДС
        await client.query(`
            INSERT INTO transactions (amount, transaction_type, category, description, vat_amount, payment_method)
            VALUES ($1, 'expense', 'Зарплата и Авансы', $2, 0, 'Наличные')
        `, [amount, `Выплата: ${description}`]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// ==========================================
// ЗАКРЫТИЕ МЕСЯЦА (ПЕРЕНОС ОСТАТКОВ)
// ==========================================
app.post('/api/salary/close-month', async (req, res) => {
    const { balances } = req.body; // Получаем массив { empId, balance }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let b of balances) {
            // Перезаписываем остаток в профиле сотрудника на новую сумму
            await client.query('UPDATE employees SET prev_balance = $1 WHERE id = $2', [b.balance, b.empId]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

// Автоматическое обновление БД для модуля зарплат (Снапшоты и Налоги)
pool.query(`
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS prev_balance NUMERIC(10, 2) DEFAULT 0;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5, 2) DEFAULT 13;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS tax_withheld NUMERIC(10, 2) DEFAULT 2600;
    
    -- Устанавливаем базовые значения по ТЗ
    UPDATE employees SET salary_official = 20000 WHERE salary_official = 0 OR salary_official IS NULL;
    UPDATE employees SET tax_rate = 13 WHERE tax_rate IS NULL;
    UPDATE employees SET tax_withheld = (salary_official * 0.13) WHERE tax_withheld IS NULL;

    ALTER TABLE timesheets 
    ADD COLUMN IF NOT EXISTS bonus NUMERIC(10, 2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS penalty NUMERIC(10, 2) DEFAULT 0;

    CREATE TABLE IF NOT EXISTS salary_payments (
        id SERIAL PRIMARY KEY, employee_id INTEGER REFERENCES employees(id),
        amount NUMERIC(10, 2) NOT NULL, payment_date DATE NOT NULL,
        payment_type VARCHAR(20) DEFAULT 'advance', description TEXT
    );

    -- Таблица "Слепков" окладов для сохранения истории прошлых месяцев
    CREATE TABLE IF NOT EXISTS monthly_salary_stats (
        id SERIAL PRIMARY KEY, employee_id INTEGER REFERENCES employees(id),
        month_str VARCHAR(7) NOT NULL, -- Формат '2026-02'
        salary_cash NUMERIC(10, 2), salary_official NUMERIC(10, 2),
        tax_rate NUMERIC(5, 2), tax_withheld NUMERIC(10, 2),
        UNIQUE(employee_id, month_str)
    );

    -- Добавляем статус сотрудникам
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';

    -- Таблица для разовых удержаний и начислений (ГСМ, Займы и тд)
    CREATE TABLE IF NOT EXISTS salary_adjustments (
        id SERIAL PRIMARY KEY, 
        employee_id INTEGER REFERENCES employees(id),
        month_str VARCHAR(7) NOT NULL,
        amount NUMERIC(10, 2) NOT NULL,
        description TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value JSONB NOT NULL
    );
    INSERT INTO settings (key, value) VALUES (
        'mix_templates',
        '{"big": [{"name": "Цемент М-600", "qty": 250, "unit": "кг"}, {"name": "Песок основной", "qty": 600, "unit": "кг"}, {"name": "Щебень", "qty": 800, "unit": "кг"}, {"name": "Мурасан 16", "qty": 2.5, "unit": "кг"}], "small": [{"name": "Песок лицевой", "qty": 200, "unit": "кг"}, {"name": "Щебень", "qty": 300, "unit": "кг"}, {"name": "Мурасан 17", "qty": 1.2, "unit": "кг"}]}'
    ) ON CONFLICT (key) DO NOTHING;

`).then(() => console.log('✅ База Зарплат обновлена (добавлены налоги и исторические слепки)'))
    .catch(err => console.error('Ошибка обновления БД:', err.message));

// Полная очистка данных зарплатного модуля за конкретный месяц
app.post('/api/debug/clear-timesheet-month', async (req, res) => {
    const { year, month } = req.body;
    const monthStr = `${year}-${month}`;
    const startDate = `${monthStr}-01`;
    const endDate = `${year}-${month}-${new Date(year, month, 0).getDate()}`;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Удаляем отметки в табеле (чтобы "Заработал на сегодня" стало 0)
        await client.query('DELETE FROM timesheets WHERE record_date >= $1 AND record_date <= $2', [startDate, endDate]);

        // 2. Удаляем записи о выданных авансах (чтобы колонка "Авансы" стала 0)
        await client.query('DELETE FROM salary_payments WHERE payment_date >= $1 AND payment_date <= $2', [startDate, endDate]);

        // 3. Удаляем "слепки" окладов за этот месяц (чтобы сбросить расчет налогов)
        await client.query('DELETE FROM monthly_salary_stats WHERE month_str = $1', [monthStr]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(err.message);
    } finally { client.release(); }
});

app.listen(port, () => {
    console.log(`🚀 ERP Плиттекс Server запущен: http://localhost:${port}`);
});