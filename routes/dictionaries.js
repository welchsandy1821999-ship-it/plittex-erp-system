// === ФАЙЛ: routes/dictionaries.js (Справочники: Товары, Кадры, Оборудование) ===
const express = require('express');
const router = express.Router();

// 👈 Добавили withTransaction
module.exports = function (pool, withTransaction) {

    // ==========================================
    // 1. СПРАВОЧНИК: ТОВАРЫ И СЫРЬЕ
    // ==========================================
    router.get('/api/categories', async (req, res) => {
        try {
            const result = await pool.query(`SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category != '' ORDER BY category`);
            res.json(result.rows.map(r => r.category));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/api/items', async (req, res) => {
        const { page = 1, limit = 50, search = '', item_type = '', category = '' } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE COALESCE(is_deleted, false) = false';
        let params = [];
        let paramIndex = 1;

        if (search) {
            whereClause += ` AND (name ILIKE $${paramIndex} OR category ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }
        if (item_type) {
            whereClause += ` AND item_type = $${paramIndex}`;
            params.push(item_type);
            paramIndex++;
        }
        if (category) {
            whereClause += ` AND category = $${paramIndex}`;
            params.push(category);
            paramIndex++;
        }

        try {
            const countRes = await pool.query(`SELECT COUNT(*) FROM items ${whereClause}`, params);
            const totalItems = parseInt(countRes.rows[0].count);
            const dataRes = await pool.query(`SELECT * FROM items ${whereClause} ORDER BY item_type, category, name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`, [...params, limit, offset]);

            res.json({
                data: dataRes.rows,
                total: totalItems,
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalItems / limit) || 1
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/items', async (req, res) => {
        const { name, item_type, category, unit, price, weight, qty_per_cycle, mold_id, gost_mark, article } = req.body;
        try {
            await pool.query(`
                INSERT INTO items (name, item_type, category, unit, current_price, weight_kg, qty_per_cycle, mold_id, gost_mark, article) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [name, item_type, category, unit, price, weight, qty_per_cycle || 1, mold_id || null, gost_mark || '', article || null]);
            res.json({ success: true, message: 'Позиция добавлена' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.put('/api/items/:id', async (req, res) => {
        const itemId = req.params.id;

        // 1. Белый список разрешенных полей (строго по схеме БД)
        const allowedFields = [
            'name', 'category', 'unit', 'current_price',
            'item_type', 'is_deleted', 'article',
            'mold_id', 'min_stock',
            'weight_kg',      // Соответствует колонке в БД
            'qty_per_cycle'   // Тот самый "Выход с 1 удара"
        ];

        // 2. Фильтрация входящих данных: оставляем только те, что в белом списке
        const updates = {};
        for (const key of Object.keys(req.body)) {
            if (allowedFields.includes(key)) {
                updates[key] = req.body[key];
            }
        }

        const keys = Object.keys(updates);

        if (keys.length === 0) {
            return res.status(400).json({ error: 'Нет допустимых данных для обновления' });
        }

        // 3. Безопасное формирование запроса (экранируем имена колонок двойными кавычками)
        const setClause = keys.map((key, i) => `"${key}" = $${i + 1}`).join(', ');
        const values = Object.values(updates);

        try {
            // ID передаем последним параметром
            await pool.query(
                `UPDATE items SET ${setClause} WHERE id = $${keys.length + 1}`,
                [...values, itemId]
            );
            res.json({ success: true, message: 'Позиция обновлена' });
        } catch (err) {
            console.error('Ошибка PUT /api/items:', err.message);
            res.status(500).json({ error: 'Ошибка при сохранении данных' });
        }
    });

    // === БЕЗОПАСНОЕ УДАЛЕНИЕ ТОВАРА (SOFT DELETE) ===
    router.delete('/api/items/:id', async (req, res) => {
        try {
            await pool.query(`UPDATE items SET is_deleted = true WHERE id = $1`, [req.params.id]);
            res.json({ success: true, message: 'Позиция перенесена в архив' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/api/products', async (req, res) => {
        try {
            const result = await pool.query(`SELECT * FROM items WHERE item_type = 'product' AND COALESCE(is_deleted, false) = false ORDER BY name ASC`);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/products/update-prices', async (req, res) => {
        const { prices } = req.body;
        if (!prices || !Array.isArray(prices) || prices.length === 0) return res.json({ success: true });

        try {
            await withTransaction(pool, async (client) => {
                const ids = prices.map(p => p.id);
                const currentPrices = prices.map(p => p.price || 0);
                const dealerPrices = prices.map(p => p.dealer_price || 0);

                const query = `
                    UPDATE items AS i SET current_price = data.cp, dealer_price = data.dp
                    FROM (SELECT unnest($1::int[]) AS id, unnest($2::numeric[]) AS cp, unnest($3::numeric[]) AS dp) AS data
                    WHERE i.id = data.id;
                `;
                await client.query(query, [ids, currentPrices, dealerPrices]);
            });
            res.json({ success: true, message: 'Прайс-лист обновлен' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ==========================================
    // 2. СПРАВОЧНИК: СОТРУДНИКИ
    // ==========================================
    router.get('/api/employees', async (req, res) => {
        try {
            const result = await pool.query(`SELECT * FROM employees WHERE status != 'deleted' ORDER BY department, full_name`);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/employees', async (req, res) => {
        const { full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status } = req.body;
        try {
            await pool.query(`
                INSERT INTO employees (full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [full_name, position, department, schedule_type, salary_cash || 0, salary_official || 20000, tax_rate || 13, tax_withheld || 2600, prev_balance || 0, status || 'active']);
            res.json({ success: true, message: 'Сотрудник добавлен' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.put('/api/employees/:id', async (req, res) => {
        const { full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status } = req.body;
        const currentMonthStr = new Date().toISOString().substring(0, 7);

        try {
            await withTransaction(pool, async (client) => {
                await client.query(`
                    UPDATE employees SET full_name=$1, position=$2, department=$3, schedule_type=$4, salary_cash=$5, salary_official=$6, tax_rate=$7, tax_withheld=$8, prev_balance=$9, status=$10
                    WHERE id=$11
                `, [full_name, position, department, schedule_type, salary_cash, salary_official, tax_rate, tax_withheld, prev_balance, status, req.params.id]);

                await client.query(`
                    UPDATE monthly_salary_stats SET salary_cash=$1, salary_official=$2, tax_rate=$3, tax_withheld=$4
                    WHERE employee_id=$5 AND month_str >= $6
                `, [salary_cash, salary_official, tax_rate, tax_withheld, req.params.id, currentMonthStr]);
            });
            res.json({ success: true, message: 'Данные обновлены' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // === БЕЗОПАСНОЕ УДАЛЕНИЕ СОТРУДНИКА (УВОЛЬНЕНИЕ) ===
    router.delete('/api/employees/:id', async (req, res) => {
        try {
            await pool.query(`UPDATE employees SET status = 'deleted' WHERE id = $1`, [req.params.id]);
            res.json({ success: true, message: 'Сотрудник перенесен в архив (уволен)' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ==========================================
    // 3. СПРАВОЧНИК: ОБОРУДОВАНИЕ (ТОиР)
    // ==========================================
    router.get('/api/equipment', async (req, res) => {
        try {
            const result = await pool.query(`SELECT * FROM equipment ORDER BY equipment_type, name`);
            res.json(result.rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/equipment', async (req, res) => {
        const { name, equipment_type, purchase_cost, planned_cycles, current_cycles, qty_per_cycle, status } = req.body;
        try {
            await pool.query(`
                INSERT INTO equipment (name, equipment_type, purchase_cost, planned_cycles, current_cycles, qty_per_cycle, status) 
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [name, equipment_type, purchase_cost, planned_cycles, current_cycles || 0, qty_per_cycle, status || 'active']);
            res.json({ success: true, message: 'Оборудование добавлено' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.put('/api/equipment/:id', async (req, res) => {
        const { name, equipment_type, purchase_cost, planned_cycles, current_cycles, qty_per_cycle, status } = req.body;
        try {
            await pool.query(`
                UPDATE equipment SET name=$1, equipment_type=$2, purchase_cost=$3, planned_cycles=$4, current_cycles=$5, qty_per_cycle=$6, status=$7 
                WHERE id=$8
            `, [name, equipment_type, purchase_cost, planned_cycles, current_cycles || 0, qty_per_cycle, status, req.params.id]);
            res.json({ success: true, message: 'Оборудование обновлено' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/api/equipment/:id/maintenance', async (req, res) => {
        const { amount, description, account_id, reset_cycles } = req.body;
        const equipId = req.params.id;

        try {
            await withTransaction(pool, async (client) => {
                if (amount > 0 && account_id) {
                    await client.query(`
                        INSERT INTO transactions (amount, transaction_type, category, description, payment_method, account_id, equipment_id)
                        VALUES ($1, 'expense', 'Ремонт и ТО оборудования', $2, 'Безналичный расчет', $3, $4)
                    `, [amount, description, account_id, equipId]);
                }
                if (reset_cycles) {
                    await client.query('UPDATE equipment SET current_cycles = 0 WHERE id = $1', [equipId]);
                }
            });
            res.json({ success: true, message: 'Ремонт зафиксирован' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/api/equipment/:id', async (req, res) => {
        try {
            await pool.query(`DELETE FROM equipment WHERE id = $1`, [req.params.id]);
            res.json({ success: true, message: 'Удалено' });
        } catch (err) {
            if (err.code === '23503') {
                res.status(400).json({ error: 'Невозможно удалить: оборудование привязано к продукции. Измените статус на "Списано".' });
            } else {
                res.status(500).json({ error: err.message });
            }
        }
    });

    return router;
};