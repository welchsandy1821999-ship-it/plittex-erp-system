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

// 1. Получение дефолтных норм замесов
app.get('/api/mix-templates', async (req, res) => {
    try {
        // Здесь можно либо сделать таблицу в БД, либо хранить как константу
        const templates = {
            big: [
                { name: 'Цемент М-600', qty: 250, unit: 'кг' },
                { name: 'Песок основной', qty: 600, unit: 'кг' },
                { name: 'Щебень', qty: 800, unit: 'кг' },
                { name: 'Мурасан 16', qty: 2.5, unit: 'кг' }
            ],
            small: [
                { name: 'Песок лицевой', qty: 200, unit: 'кг' },
                { name: 'Щебень', qty: 300, unit: 'кг' },
                { name: 'Мурасан 17', qty: 1.2, unit: 'кг' }
            ]
        };
        res.json(templates);
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
                   SUM(ABS(m.quantity) * i.current_price) as cost
            FROM inventory_movements m
            JOIN items i ON m.item_id = i.id
            WHERE m.batch_id = $1 AND m.movement_type = 'production_expense'
            GROUP BY i.name, i.unit
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

app.listen(port, () => {
    console.log(`🚀 ERP Плиттекс Server запущен: http://localhost:${port}`);
});