// === ФАЙЛ: routes/inventory.js (Бэкенд-маршруты для модуля Склада) ===

const express = require('express');
const router = express.Router();
const Big = require('big.js');
const { sendNotify } = require('../utils/telegram');
const ExcelJS = require('exceljs');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// 👈 Добавили withTransaction третьим аргументом
module.exports = function (pool, getWhId, withTransaction) {
    const { requireAdmin } = require('../middleware/auth');

    // ------------------------------------------------------------------
    // ИНВЕНТАРИЗАЦИЯ: ПЕЧАТЬ БЛАНКА (HTML)
    // ------------------------------------------------------------------
    router.get('/api/inventory/print', requireAdmin, async (req, res) => {
        try {
            const { mode, wh } = req.query; // mode: 'blind' / 'full', wh: 'all' / '4' / etc
            
            let queryOptions = "WHERE w.type IN ('materials', 'drying', 'finished', 'defect', 'markdown')";
            const params = [];
            
            if (wh && wh !== 'all') {
                queryOptions += " AND w.id = $1";
                params.push(wh);
            }

            const result = await pool.query(`
                SELECT 
                    m.item_id, i.name as item_name, i.unit,
                    m.warehouse_id, w.name as warehouse_name, 
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE m.batch_id END as batch_id, 
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE b.batch_number END as batch_number,
                    SUM(m.quantity) as total 
                FROM inventory_movements m
                JOIN items i ON m.item_id = i.id
                JOIN warehouses w ON m.warehouse_id = w.id
                LEFT JOIN production_batches b ON m.batch_id = b.id
                ${queryOptions}
                GROUP BY m.item_id, i.name, i.unit, m.warehouse_id, w.name, 
                         CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE m.batch_id END, 
                         CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE b.batch_number END
                HAVING SUM(m.quantity) <> 0
                ORDER BY m.warehouse_id, i.name
            `, params);

            let dataMap = new Map();
            result.rows.forEach(r => dataMap.set(`${r.item_id}_${r.warehouse_id}_${r.batch_id || 'null'}`, r));

            if (mode === 'blind') {
                // В слепом бланке добираем пустые/нулевые позиции (если склад не указан или = сырье/готовая)
                // Но проще всего добавить все товары
                const allItems = await pool.query("SELECT id, name, unit FROM items");
                // TODO: Если выбран склад №4, добавим все готовые товары с нулевым остатком
            }

            const sortedData = Array.from(dataMap.values()).sort((a,b) => a.warehouse_id - b.warehouse_id || a.item_name.localeCompare(b.item_name));

            let html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>Бланк Ревизии ${wh && wh !== 'all' ? 'Склад №' + wh : ''}</title>
                    <style>
                        body { font-family: Arial, sans-serif; font-size: 12px; margin: 20px; }
                        h1 { text-align: center; }
                        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                        th, td { border: 1px solid #000; padding: 6px; text-align: left; }
                        th { background-color: #f2f2f2; }
                        .empty-cell { min-width: 80px; }
                        @media print {
                            body { margin: 0; padding: 20px; }
                            button { display: none; }
                            table { page-break-inside: auto }
                            tr { page-break-inside: avoid; page-break-after: auto }
                            thead { display: table-header-group }
                            tfoot { display: table-footer-group }
                        }
                    </style>
                </head>
                <body>
                    <button onclick="window.print()" style="padding: 10px 20px; font-size: 16px; margin-bottom: 20px; cursor: pointer;">🖨️ Печать</button>
                    <h1>Бланк Инвентаризации ${mode === 'blind' ? '(Слепой)' : '(Полный)'}</h1>
                    <p>Дата печати: ${new Date().toLocaleString('ru-RU')}</p>
                    
                    <table>
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Товар</th>
                                <th>Партия</th>
                                <th>Склад</th>
                                ${mode === 'full' ? '<th>Расчет (в БД)</th>' : ''}
                                <th>ФАКТ (Заполнить)</th>
                                <th>Примечание</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            let i = 1;
            for (const row of sortedData) {
                html += `
                    <tr>
                        <td>${i++}</td>
                        <td>${row.item_id} - ${row.item_name}</td>
                        <td>${row.batch_number || '-'}</td>
                        <td>${row.warehouse_name}</td>
                        ${mode === 'full' ? `<td>${parseFloat(row.total || 0)}</td>` : ''}
                        <td class="empty-cell"></td>
                        <td class="empty-cell"></td>
                    </tr>
                `;
            }

            html += `
                        </tbody>
                    </table>
                    <div style="margin-top: 40px; display: flex; justify-content: space-between; font-size: 14px;">
                        <div>Подпись ревизора: ___________________ / ___________________</div>
                        <div>Подпись кладовщика: ___________________ / ___________________</div>
                    </div>
                    <script>window.onload = function() { window.print(); }</script>
                </body>
                </html>
            `;

            res.send(html);
        } catch (err) {
            console.error(err);
            res.status(500).send('Внутренняя ошибка сервера при формировании бланка.');
        }
    });

    // ------------------------------------------------------------------
    // ИНВЕНТАРИЗАЦИЯ: ЭКСПОРТ В EXCEL
    // ------------------------------------------------------------------
    router.get('/api/inventory/export', requireAdmin, async (req, res) => {
        try {
            const { mode, wh } = req.query; // 'blind' или 'full'
            
            let queryOptions = "WHERE w.type IN ('materials', 'drying', 'finished', 'defect', 'markdown')";
            const params = [];
            
            if (wh && wh !== 'all') {
                queryOptions += " AND w.id = $1";
                params.push(wh);
            }

            const result = await pool.query(`
                SELECT 
                    m.item_id, i.name as item_name, i.unit,
                    m.warehouse_id, w.name as warehouse_name, 
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE m.batch_id END as batch_id, 
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE b.batch_number END as batch_number,
                    SUM(m.quantity) as total 
                FROM inventory_movements m
                JOIN items i ON m.item_id = i.id
                JOIN warehouses w ON m.warehouse_id = w.id
                LEFT JOIN production_batches b ON m.batch_id = b.id
                ${queryOptions}
                GROUP BY m.item_id, i.name, i.unit, m.warehouse_id, w.name, 
                         CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE m.batch_id END, 
                         CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE b.batch_number END
                HAVING SUM(m.quantity) <> 0 OR m.item_id > 0
                ORDER BY m.warehouse_id, i.name
            `, params);

            // Добираем все позиции из базы (вписываем их как 0 остаток для 4 и 5 склада)
            const allItems = await pool.query("SELECT id, name, unit FROM items");
            let dataMap = new Map();
            
            result.rows.forEach(r => {
                if(parseFloat(r.total) !== 0) {
                    dataMap.set(`${r.item_id}_${r.warehouse_id}_${r.batch_id || 'null'}`, r);
                }
            });

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Инвентаризация');

            worksheet.columns = [
                { header: 'ID ТОВАРА', key: 'item_id', width: 15 },
                { header: 'ID СКЛАДА', key: 'wh_id', width: 15 },
                { header: 'ID ПАРТИИ', key: 'batch_id', width: 15 },
                { header: 'СКЛАД', key: 'wh_name', width: 25 },
                { header: '№ ПАРТИИ (если есть)', key: 'batch_num', width: 25 },
                { header: 'НАИМЕНОВАНИЕ', key: 'item_name', width: 50 },
                { header: 'РАСЧЕТНЫЙ ОСТАТОК', key: 'erp_qty', width: 25 },
                { header: 'ФАКТИЧЕСКИЙ ОСТАТОК', key: 'fact_qty', width: 25 }
            ];

            // Заголовок - стили
            worksheet.getRow(1).font = { bold: true };
            worksheet.getRow(1).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor:{ argb:'FFD3D3D3' }
            };

            const sortedData = Array.from(dataMap.values()).sort((a,b) => a.warehouse_id - b.warehouse_id || a.item_name.localeCompare(b.item_name));

            for (const row of sortedData) {
                const isBlind = mode === 'blind';
                worksheet.addRow({
                    item_id: row.item_id,
                    wh_id: row.warehouse_id,
                    batch_id: row.batch_id || '',
                    wh_name: row.warehouse_name,
                    batch_num: row.batch_number || '',
                    item_name: row.item_name,
                    erp_qty: isBlind ? '' : parseFloat(row.total || 0),
                    fact_qty: ''
                });
            }

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename=Inventory_Export.xlsx');

            await workbook.xlsx.write(res);
            res.end();
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
        }
    });

    // ------------------------------------------------------------------
    // ИНВЕНТАРИЗАЦИЯ: ПРЕДВАРИТЕЛЬНЫЙ ПАРСИНГ EXCEL
    // ------------------------------------------------------------------
    router.post('/api/inventory/import-preview', requireAdmin, upload.single('excelFile'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'Необходимо загрузить файл .xlsx' });

            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(req.file.buffer);
            const worksheet = workbook.getWorksheet(1);
            if (!worksheet) return res.status(400).json({ error: 'Файл не содержит листов' });

            const dataRows = [];
            worksheet.eachRow((row, rowNumber) => {
                if (rowNumber === 1) return; // Пропускаем заголовок

                const item_id = row.getCell(1).value;
                const wh_id = row.getCell(2).value;
                let batch_id = row.getCell(3).value;
                if (!batch_id || String(batch_id).trim() === '') batch_id = null;
                const wh_name = row.getCell(4).value;
                const batch_num = row.getCell(5).value;
                const item_name = row.getCell(6).value;
                const erp_qty = row.getCell(7).value || 0;
                let fact_qty = row.getCell(8).value;
                
                // Если факт не заполнили, считаем, что сошлось с расчетом (если он был), иначе пусто = 0
                if (fact_qty === null || fact_qty === undefined || String(fact_qty).trim() === '') {
                    fact_qty = erp_qty || 0;
                }

                dataRows.push({
                    item_id: parseInt(item_id),
                    wh_id: parseInt(wh_id),
                    batch_id: batch_id ? parseInt(batch_id) : null,
                    wh_name: String(wh_name || ''),
                    batch_num: String(batch_num || ''),
                    item_name: String(item_name || ''),
                    erp_qty: parseFloat(erp_qty || 0),
                    fact_qty: parseFloat(fact_qty)
                });
            });

            // Сейчас нам нужно сравнить это с БД напрямую, чтобы найти реальные отклонения
            const dbStock = await pool.query(`
                SELECT item_id, warehouse_id, batch_id, COALESCE(SUM(quantity), 0) as total
                FROM inventory_movements
                GROUP BY item_id, warehouse_id, batch_id
            `);

            const dbMap = new Map();
            dbStock.rows.forEach(r => {
                dbMap.set(`${r.item_id}_${r.warehouse_id}_${r.batch_id || 'null'}`, parseFloat(r.total || 0));
            });

            const results = {
                matches: [],
                differences: [],
                errors: []
            };

            for (const r of dataRows) {
                if (isNaN(r.item_id) || isNaN(r.wh_id)) {
                    results.errors.push({ ...r, error_msg: "Неверный формат ID в строке" });
                    continue;
                }
                if (isNaN(r.fact_qty) || r.fact_qty < 0) {
                    results.errors.push({ ...r, error_msg: "Факт. количество не может быть отрицательным или пустым" });
                    continue;
                }

                const currentErp = dbMap.get(`${r.item_id}_${r.wh_id}_${r.batch_id || 'null'}`) || 0;
                
                if (Math.abs(currentErp - r.fact_qty) < 0.01) {
                    results.matches.push({ ...r, db_qty: currentErp });
                } else {
                    results.differences.push({ ...r, db_qty: currentErp, delta: (r.fact_qty - currentErp) });
                }
            }

            res.json(results);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Ошибка обработки файла' });
        }
    });

    // ------------------------------------------------------------------
    // ПОЛУЧЕНИЕ ДАТ, В КОТОРЫЕ БЫЛИ ЗАКУПКИ (ДЛЯ КАЛЕНДАРЯ)
    // ------------------------------------------------------------------

    router.get('/api/inventory/purchase-dates', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT DISTINCT to_char(movement_date, 'YYYY-MM-DD') as date
                FROM inventory_movements
                WHERE movement_type = 'purchase'
                ORDER BY date DESC
            `);
            const dates = result.rows.map(r => r.date);
            res.json(dates);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // ИСТОРИЯ ПРИХОДОВ ЗА КОНКРЕТНУЮ ДАТУ
    // ------------------------------------------------------------------
    router.get('/api/inventory/daily-purchases', async (req, res) => {
        try {
            const { date } = req.query;
            const result = await pool.query(`
                SELECT 
                    m.id, 
                    i.name as item_name, i.unit,
                    m.quantity, 
                    m.amount, 
                    c.name as supplier_name, 
                    (m.amount / NULLIF(m.quantity, 0)) as price
                FROM inventory_movements m
                JOIN items i ON m.item_id = i.id
                LEFT JOIN counterparties c ON m.supplier_id = c.id
                WHERE m.movement_type = 'purchase' 
                  AND to_char(m.movement_date, 'YYYY-MM-DD') = $1
                ORDER BY m.movement_date DESC
            `, [date]);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // ИНФОРМЕР: ОСТАТОК И ПОСЛЕДНЯЯ ЦЕНА ЗАКУПКИ
    // ------------------------------------------------------------------
    router.get('/api/inventory/material-stats/:id', async (req, res) => {
        try {
            const itemId = req.params.id;
            const materialsWh = await getWhId(pool, 'materials');

            // 1. Считаем текущий остаток на складе сырья
            const stockRes = await pool.query(`
                SELECT COALESCE(SUM(quantity), 0) as balance 
                FROM inventory_movements 
                WHERE item_id = $1 AND warehouse_id = $2
            `, [itemId, materialsWh]);

            // 2. Ищем последнюю цену закупки
            const lastPurchaseRes = await pool.query(`
                SELECT (amount / NULLIF(quantity, 0)) as last_price, to_char(created_at, 'DD.MM.YYYY') as last_date
                FROM inventory_movements
                WHERE item_id = $1 AND movement_type = 'purchase'
                ORDER BY created_at DESC
                LIMIT 1
            `, [itemId]);

            res.json({
                balance: stockRes.rows[0]?.balance || 0,
                lastPrice: lastPurchaseRes.rows[0]?.last_price || null,
                lastDate: lastPurchaseRes.rows[0]?.last_date || null
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 1.5. ОТЧЕТ ПО ОБЩЕЙ СТОИМОСТИ СКЛАДОВ (VALUATION)
    // ------------------------------------------------------------------
    router.get('/api/inventory/valuation', async (req, res) => {
        try {
            // Учитываем только нужные склады (1, 3, 4, 5)
            // Исключаем отрицательное количество из подсчета стоимости через GREATEST(balance, 0)
            const result = await pool.query(`
                WITH item_balances AS (
                    SELECT 
                        m.warehouse_id,
                        w.name as warehouse_name,
                        m.item_id,
                        i.name as item_name,
                        i.current_price,
                        SUM(m.quantity) as balance
                    FROM inventory_movements m
                    JOIN items i ON m.item_id = i.id
                    JOIN warehouses w ON m.warehouse_id = w.id
                    WHERE m.warehouse_id IN (1, 3, 4, 5)
                    GROUP BY m.warehouse_id, w.name, m.item_id, i.name, i.current_price
                    HAVING SUM(m.quantity) <> 0
                )
                SELECT 
                    warehouse_id as id,
                    warehouse_name as name,
                    ROUND(SUM(GREATEST(balance, 0) * COALESCE(current_price, 0) * (CASE WHEN item_name ILIKE '%2 сорт%' OR item_name ILIKE '%уценка%' THEN 0.5 ELSE 1 END)), 2) as value,
                    COUNT(item_id) as items_count
                FROM item_balances
                GROUP BY warehouse_id, warehouse_name
                ORDER BY warehouse_id ASC;
            `);

            let grand_total = new Big(0);
            const warehouses = result.rows.map(row => {
                const val = Number(new Big(row.value || 0));
                grand_total = grand_total.plus(val);
                return {
                    id: parseInt(row.id),
                    name: row.name,
                    value: val,
                    items_count: parseInt(row.items_count)
                };
            });

            res.json({
                grand_total: Number(grand_total.toFixed(2)),
                warehouses: warehouses
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    router.get('/api/inventory', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    m.item_id, i.name as item_name, i.unit, 
                    m.warehouse_id, w.name as warehouse_name, w.type as warehouse_type,
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE m.batch_id END as batch_id, 
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE b.batch_number END as batch_number, 
                    CASE WHEN w.type = 'reserve' THEN m.linked_order_item_id ELSE NULL END as linked_order_item_id,
                    CASE WHEN w.type = 'reserve' THEN co.doc_number ELSE NULL END as order_doc_number,
                    CASE WHEN w.type = 'reserve' THEN co.id ELSE NULL END as order_id,
                    SUM(m.quantity) as total 
                FROM inventory_movements m
                JOIN items i ON m.item_id = i.id
                JOIN warehouses w ON m.warehouse_id = w.id
                LEFT JOIN production_batches b ON m.batch_id = b.id
                LEFT JOIN client_order_items coi ON w.type = 'reserve' AND m.linked_order_item_id = coi.id
                LEFT JOIN client_orders co ON coi.order_id = co.id
                GROUP BY 
                    m.item_id, i.name, i.unit, 
                    m.warehouse_id, w.name, w.type,
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE m.batch_id END, 
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE b.batch_number END,
                    CASE WHEN w.type = 'reserve' THEN m.linked_order_item_id ELSE NULL END,
                    CASE WHEN w.type = 'reserve' THEN co.doc_number ELSE NULL END,
                    CASE WHEN w.type = 'reserve' THEN co.id ELSE NULL END
                HAVING SUM(m.quantity) <> 0 
                ORDER BY w.name, i.name
            `);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 2. МАРШРУТ: СПИСАНИЕ В БРАК ИЛИ УТИЛЬ (POST /api/inventory/scrap)
    // ------------------------------------------------------------------
    router.post('/api/inventory/scrap', requireAdmin, async (req, res) => {
        const { itemId, batchId, warehouseId, targetWarehouseId, scrapQty, description } = req.body;

        try {
            // 👈 Используем безопасную транзакцию
            await withTransaction(pool, async (client) => {
                const defectWh = await getWhId(client, 'defect');

                // 🛡️ ЗАЩИТА: Проверяем, что на складе достаточно товара
                let stockQuery = `SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`;
                const stockParams = [itemId, warehouseId];
                if (batchId) { stockQuery += ` AND batch_id = $3`; stockParams.push(batchId); }
                else { stockQuery += ` AND batch_id IS NULL`; }
                const stockRes = await client.query(stockQuery, stockParams);
                const available = Number(new Big(stockRes.rows[0].balance || 0));
                const requested = Math.abs(scrapQty);
                if (requested > available) {
                    throw new Error(`Недостаточно товара на складе. Доступно: ${available}, запрошено: ${requested}`);
                }

                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
                    VALUES ($1, $2, 'scrap_writeoff', $3, $4, $5)
                `, [itemId, -Math.abs(scrapQty), description, warehouseId, batchId || null]);

                const destType = parseInt(targetWarehouseId) === defectWh ? 'defect_receipt' : 'scrap_receipt';
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [itemId, Math.abs(scrapQty), destType, description, targetWarehouseId, batchId || null]);
            });
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`⚠️ <b>Списание в брак</b>\nКоличество: ${scrapQty}\nПричина: ${description || 'Не указана'}`);

            res.json({ success: true, message: 'Успешно перемещено' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // ИНВЕНТАРИЗАЦИЯ: КОРРЕКТИРОВКА ОСТАТКОВ (ИСПРАВЛЕННЫЙ БЕЗОПАСНЫЙ МЕТОД)
    // ------------------------------------------------------------------
    router.post('/api/inventory/audit', requireAdmin, async (req, res) => {
        const { warehouseId, adjustments, auditDate } = req.body;
        const userId = req.user ? req.user.id : null;

        try {
            await withTransaction(pool, async (client) => {
                for (const adj of adjustments) {
                    const { itemId, batchId, actualQty } = adj;
                    const wh_id = adj.warehouseId || warehouseId;

                    // 1. Сначала блокируем строки (FOR UPDATE), чтобы никто не вставил новое движение
                    let lockQuery = `
                        SELECT id FROM inventory_movements 
                        WHERE item_id = $1 AND warehouse_id = $2
                    `;
                    const params = [itemId, wh_id];
                    if (batchId) {
                        lockQuery += ` AND batch_id = $3`;
                        params.push(batchId);
                    } else {
                        lockQuery += ` AND batch_id IS NULL`;
                    }

                    // Выполняем блокировку существующих строк
                    await client.query(lockQuery + " FOR UPDATE", params);

                    // 2. Теперь спокойно считаем сумму (агрегат отдельно от FOR UPDATE)
                    let sumQuery = `
                        SELECT COALESCE(SUM(quantity), 0) as balance 
                        FROM inventory_movements 
                        WHERE item_id = $1 AND warehouse_id = $2
                    `;
                    if (batchId) sumQuery += ` AND batch_id = $3`;
                    else sumQuery += ` AND batch_id IS NULL`;

                    const stockRes = await client.query(sumQuery, params);
                    const currentBalanceBig = new Big(stockRes.rows[0].balance || 0);
                    const currentBalance = Number(currentBalanceBig);

                    // 3. Вычисляем дельту
                    const diffQtyBig = new Big(actualQty || 0).minus(currentBalanceBig);
                    const diffQty = Number(diffQtyBig);

                    // 4. Записываем корректировку, если есть разница
                    if (diffQtyBig.abs().gt(0.0001)) {
                        const dateStrPart = auditDate ? ` от ${auditDate}` : '';
                        const desc = `Инвентаризация${dateStrPart}: факт ${actualQty}, было ${currentBalance}`;

                        await client.query(`
                            INSERT INTO inventory_movements 
                            (item_id, warehouse_id, batch_id, quantity, movement_type, description, user_id, movement_date, created_at) 
                            VALUES ($1, $2, $3, $4, 'audit_adjustment', $5, $6, COALESCE($7::timestamp, CURRENT_TIMESTAMP), COALESCE($7::timestamp, CURRENT_TIMESTAMP))
                        `, [itemId, wh_id, batchId, diffQty, desc, userId, auditDate || null]);
                    }
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');

            res.json({ success: true, message: 'Инвентаризация завершена успешно' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 4. МАРШРУТ: РАСПАЛУБКА И ПРИЕМКА (POST /api/move-wip)
    // ------------------------------------------------------------------
    router.post('/api/move-wip', requireAdmin, async (req, res) => {
        const { batchId, tileId, currentWipQty, goodQty, grade2Qty, scrapQty, isComplete } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                // ✅ ТЕПЕРЬ ОНО ВНУТРИ, ТУТ client СУЩЕСТВУЕТ
                let userId = null;
                if (req.user && req.user.id) {
                    const userCheck = await client.query('SELECT id FROM users WHERE id = $1', [req.user.id]);
                    if (userCheck.rows.length > 0) userId = req.user.id;
                }

                const dryingWh = await getWhId(client, 'drying');
                const finishedWh = await getWhId(client, 'finished');
                const markdownWh = await getWhId(client, 'markdown');
                const defectWh = await getWhId(client, 'defect');

                let totalRemoved = goodQty + grade2Qty + scrapQty;
                if (isComplete) totalRemoved = currentWipQty;

                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                    VALUES ($1, $2, 'wip_expense', 'Распалубка: Выход из сушилки', $3, $4, $5)
                `, [tileId, -totalRemoved, dryingWh, batchId, userId]);

                if (goodQty > 0) {
                    let remainingGood = Number(new Big(goodQty));
                    const reserveWhId = await getWhId(client, 'reserve');

                    const pendingOrders = await client.query(`
                        SELECT coi.id, coi.qty_production, co.doc_number 
                        FROM client_order_items coi 
                        JOIN client_orders co ON coi.order_id = co.id 
                        WHERE coi.item_id = $1 
                          AND coi.qty_production > 0 
                          AND co.status IN ('pending', 'processing')
                        ORDER BY co.id ASC
                    `, [tileId]);

                    for (let order of pendingOrders.rows) {
                        if (remainingGood <= 0) break;
                        const orderNeeds = Number(new Big(order.qty_production));
                        const allocate = Math.min(remainingGood, orderNeeds);
                        remainingGood -= allocate;

                        await client.query(`
                            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id)
                            VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6, $7)
                        `, [tileId, allocate, `Распалубка: сразу в Резерв по ${order.doc_number}`, reserveWhId, batchId, userId, order.id]);

                        await client.query(`
                            UPDATE client_order_items 
                            SET qty_reserved = COALESCE(qty_reserved, 0) + $1,
                                qty_production = GREATEST(COALESCE(qty_production, 0) - $1, 0)
                            WHERE id = $2
                        `, [allocate, order.id]);

                        await client.query(`
                            UPDATE planned_production 
                            SET quantity = GREATEST(COALESCE(quantity, 0) - $1, 0)
                            WHERE order_item_id = $2
                        `, [allocate, order.id]);
                        
                        await client.query(`DELETE FROM planned_production WHERE order_item_id = $1 AND quantity <= 0`, [order.id]);
                    }

                    if (remainingGood > 0) {
                        await client.query(`
                            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                            VALUES ($1, $2, 'finished_receipt', 'Распалубка: 1-й сорт', $3, $4, $5)
                        `, [tileId, remainingGood, finishedWh, batchId, userId]);
                    }
                }

                if (grade2Qty > 0) {
                    await client.query(`
                        INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                        VALUES ($1, $2, 'markdown_receipt', 'Распалубка: 2-й сорт (Уценка)', $3, $4, $5)
                    `, [tileId, grade2Qty, markdownWh, batchId, userId]);
                }

                if (scrapQty > 0) {
                    await client.query(`
                        INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                        VALUES ($1, $2, 'scrap_receipt', 'Распалубка: Брак (Бой)', $3, $4, $5)
                    `, [tileId, scrapQty, defectWh, batchId, userId]);
                }

                // 🚀 НОВОЕ: Накапливаем 1-й сорт для сдельной зарплаты при каждой распалубке партии
                if (batchId && goodQty > 0) {
                    await client.query(`
                        UPDATE production_batches 
                        SET actual_good_qty = COALESCE(actual_good_qty, 0) + $1 
                        WHERE id = $2
                    `, [goodQty, batchId]);
                }

                if (isComplete && batchId) {
                    await client.query(`UPDATE production_batches SET status = 'completed' WHERE id = $1`, [batchId]);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            // Уведомление в ТГ можно не слать, если распалубка делается 100 раз на дню, но если нужно, раскомментируй строку ниже:
            // sendNotify(`📦 <b>Распалубка</b>\nПлитка переведена из сушилки на склад.`);

            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 5. МАРШРУТ: БЕЗВОЗВРАТНАЯ УТИЛИЗАЦИЯ
    // ------------------------------------------------------------------
    router.post('/api/inventory/dispose', requireAdmin, async (req, res) => {
        const { itemId, batchId, warehouseId, disposeQty, description } = req.body;

        try {
            await withTransaction(pool, async (client) => {
                // ✅ ПЕРЕНЕСЛИ СЮДА. Теперь client определен.
                let userId = null;
                if (req.user && req.user.id) {
                    const userCheck = await client.query('SELECT id FROM users WHERE id = $1', [req.user.id]);
                    if (userCheck.rows.length > 0) {
                        userId = req.user.id;
                    } else {
                        console.warn(`Предупреждение: Пользователь ${req.user.id} не найден.`);
                    }
                }

                // 🛡️ ЗАЩИТА: Проверяем, что на складе достаточно товара
                let stockQuery = `SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`;
                const stockParams = [itemId, warehouseId];
                if (batchId) { stockQuery += ` AND batch_id = $3`; stockParams.push(batchId); }
                else { stockQuery += ` AND batch_id IS NULL`; }
                const stockRes = await client.query(stockQuery, stockParams);
                const available = Number(new Big(stockRes.rows[0].balance || 0));
                const requested = Math.abs(disposeQty);
                if (requested > available) {
                    throw new Error(`Недостаточно товара на складе. Доступно: ${available}, запрошено: ${requested}`);
                }

                // Само списание
                await client.query(`
                INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id)
                VALUES ($1, $2, 'disposal_writeoff', $3, $4, $5, $6)
            `, [
                    itemId,
                    -Math.abs(disposeQty),
                    description || 'Безвозвратная утилизация (вывоз)',
                    warehouseId,
                    batchId || null,
                    userId // Передаем полученный выше ID или null
                ]);
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`🗑️ <b>Утилизация (Вывоз)</b>\nСписано: ${disposeQty} ед.`);

            res.json({ success: true, message: 'Успешно утилизировано' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // БЫСТРОЕ СОЗДАНИЕ ПОСТАВЩИКА ИЗ МОДУЛЯ ЗАКУПОК
    // ------------------------------------------------------------------
    router.post('/api/inventory/quick-supplier', async (req, res) => {
        try {
            const { name, inn } = req.body;
            if (!name) return res.status(400).json({ error: 'Название обязательно' });

            // Вставляем контрагента и сразу возвращаем его ID и данные
            const result = await pool.query(`
                INSERT INTO counterparties (name, inn) 
                VALUES ($1, $2) RETURNING id, name, inn
            `, [name, inn || null]);

            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // УДАЛЕНИЕ ЗАКУПКИ (ОТМЕНА ПРИХОДА И ВОЗВРАТ СРЕДСТВ + ОТКАТ ЦЕНЫ)
    // ------------------------------------------------------------------
    router.delete('/api/inventory/purchase/:id', requireAdmin, async (req, res) => {
        const purchaseId = req.params.id;

        try {
            await withTransaction(pool, async (client) => {
                const moveCheck = await client.query(`
                    SELECT item_id, quantity, amount FROM inventory_movements 
                    WHERE id = $1 AND movement_type = 'purchase'
                `, [purchaseId]);

                if (moveCheck.rows.length === 0) throw new Error('Закупка не найдена или уже удалена');

                // --- МАГИЯ СРЕДНЕВЗВЕШЕННОЙ СТОИМОСТИ (ОТКАТ) ---
                const itemId = moveCheck.rows[0].item_id;
                const oldQty = new Big(moveCheck.rows[0].quantity);
                const oldAmount = new Big(moveCheck.rows[0].amount);

                const materialsWh = await getWhId(client, 'materials');
                const stockRes = await client.query(`SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`, [itemId, materialsWh]);
                const currentBalance = new Big(stockRes.rows[0].balance || 0);

                const itemRes = await client.query(`SELECT current_price FROM items WHERE id = $1 FOR UPDATE`, [itemId]);
                const currentPrice = new Big(itemRes.rows[0].current_price || 0);

                const newBalance = currentBalance.minus(oldQty);
                if (newBalance.gt(0)) {
                    // (Текущая Стоимость - Стоимость Удаляемой Партии) / Оставшийся Объем
                    let newAvgPrice = currentBalance.times(currentPrice).minus(oldAmount).div(newBalance);
                    if (newAvgPrice.lt(0)) newAvgPrice = new Big(0); // Защита от минуса
                    await client.query(`UPDATE items SET current_price = $1 WHERE id = $2`, [newAvgPrice.toFixed(2), itemId]);
                }
                // ----------------------------------------------

                await client.query(`DELETE FROM transactions WHERE source_module = 'purchase' AND description LIKE $1`, [`%движение склада #${purchaseId})%`]);
                await client.query(`DELETE FROM inventory_movements WHERE id = $1`, [purchaseId]);
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true, message: 'Закупка успешно отменена' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // СОХРАНЕНИЕ ИЗМЕНЕНИЙ ЗАКУПКИ (UPDATE + ПЕРЕСЧЕТ СРЕДНЕЙ ЦЕНЫ)
    // ------------------------------------------------------------------
    router.put('/api/inventory/purchase/:id', requireAdmin, async (req, res) => {
        const purchaseId = req.params.id;
        const { itemId, counterparty_id, account_id, quantity, pricePerUnit, purchaseDate, totalCost: frontendTotal, deliveryCost, deliveryAccountId } = req.body;

        const qtyNum = Number(new Big(quantity || 0));
        const priceNum = Number(new Big(pricePerUnit || 0));
        const delCostNum = Number(new Big(deliveryCost || 0));

        if (!itemId || !counterparty_id || isNaN(qtyNum) || qtyNum <= 0 || isNaN(priceNum) || priceNum <= 0) {
            return res.status(400).json({ error: 'Некорректные данные' });
        }

        try {
            await withTransaction(pool, async (client) => {
                const materialCost = frontendTotal ? new Big(frontendTotal).toFixed(2) : new Big(qtyNum).times(priceNum).toFixed(2);
                const totalAmount = new Big(materialCost).plus(delCostNum).toFixed(2);
                const descMatch = `%движение склада #${purchaseId})%`;

                // --- МАГИЯ СРЕДНЕВЗВЕШЕННОЙ СТОИМОСТИ (ПЕРЕСЧЕТ) ---
                const materialsWh = await getWhId(client, 'materials');
                const oldMoveRes = await client.query(`SELECT quantity, amount FROM inventory_movements WHERE id = $1 AND movement_type = 'purchase'`, [purchaseId]);

                if (oldMoveRes.rows.length > 0) {
                    const oldQty = new Big(oldMoveRes.rows[0].quantity);
                    const oldAmount = new Big(oldMoveRes.rows[0].amount);

                    const stockRes = await client.query(`SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`, [itemId, materialsWh]);
                    const currentBalance = new Big(stockRes.rows[0].balance || 0);

                    const itemRes = await client.query(`SELECT current_price FROM items WHERE id = $1 FOR UPDATE`, [itemId]);
                    const currentPrice = new Big(itemRes.rows[0].current_price || 0);

                    // Сначала виртуально "изымаем" старую закупку со склада
                    const revertedBalance = currentBalance.minus(oldQty);
                    const revertedValue = currentBalance.times(currentPrice).minus(oldAmount);

                    const newQtyBig = new Big(qtyNum);
                    let newAvgPrice = new Big(0);

                    // Затем прибавляем новые, отредактированные данные
                    if (revertedBalance.lte(0)) {
                        newAvgPrice = new Big(totalAmount).div(newQtyBig);
                    } else {
                        newAvgPrice = revertedValue.plus(totalAmount).div(revertedBalance.plus(newQtyBig));
                    }
                    if (newAvgPrice.lt(0)) newAvgPrice = new Big(totalAmount).div(newQtyBig);

                    await client.query(`UPDATE items SET current_price = $1 WHERE id = $2`, [newAvgPrice.toFixed(2), itemId]);
                }
                // ----------------------------------------------

                await client.query(`
                    UPDATE inventory_movements 
                    SET item_id = $1, supplier_id = $2, quantity = $3, amount = $4, delivery_cost = $5,
                        created_at = COALESCE($6::timestamp, CURRENT_TIMESTAMP), 
                        description = $7
                    WHERE id = $8 AND movement_type = 'purchase'
                `, [itemId, counterparty_id, qtyNum, totalAmount, delCostNum, purchaseDate || null, `Закупка сырья (Мат: ${materialCost}, Дост: ${delCostNum})`, purchaseId]);

                const oldMatTx = await client.query(`SELECT id FROM transactions WHERE source_module = 'purchase' AND description LIKE $1 AND category = 'Закупка сырья'`, [descMatch]);
                if (account_id) {
                    if (oldMatTx.rows.length > 0) {
                        await client.query(`UPDATE transactions SET account_id = $1, amount = $2, created_at = COALESCE($3::timestamp, CURRENT_TIMESTAMP) WHERE id = $4`, [account_id, materialCost, purchaseDate || null, oldMatTx.rows[0].id]);
                    } else {
                        await client.query(`INSERT INTO transactions (account_id, amount, transaction_type, category, description, counterparty_id, payment_method, source_module, created_at, linked_purchase_id) VALUES ($1, $2, 'expense', 'Закупка сырья', $3, $4, 'Безналичный расчет', 'purchase', COALESCE($5::timestamp, CURRENT_TIMESTAMP), $6)`, [account_id, materialCost, `Оплата закупки (движение склада #${purchaseId})`, counterparty_id, purchaseDate || null, purchaseId]);
                    }
                } else if (oldMatTx.rows.length > 0) {
                    await client.query(`DELETE FROM transactions WHERE id = $1`, [oldMatTx.rows[0].id]);
                }

                const oldDelTx = await client.query(`SELECT id FROM transactions WHERE source_module = 'purchase' AND description LIKE $1 AND category = 'Транспортные расходы'`, [descMatch]);
                if (delCostNum > 0 && deliveryAccountId) {
                    if (oldDelTx.rows.length > 0) {
                        await client.query(`UPDATE transactions SET account_id = $1, amount = $2, created_at = COALESCE($3::timestamp, CURRENT_TIMESTAMP) WHERE id = $4`, [deliveryAccountId, delCostNum, purchaseDate || null, oldDelTx.rows[0].id]);
                    } else {
                        await client.query(`INSERT INTO transactions (account_id, amount, transaction_type, category, description, counterparty_id, payment_method, source_module, created_at, linked_purchase_id) VALUES ($1, $2, 'expense', 'Транспортные расходы', $3, $4, 'Безналичный расчет', 'purchase', COALESCE($5::timestamp, CURRENT_TIMESTAMP), $6)`, [deliveryAccountId, delCostNum, `Оплата доставки (движение склада #${purchaseId})`, counterparty_id, purchaseDate || null, purchaseId]);
                    }
                } else if (oldDelTx.rows.length > 0) {
                    await client.query(`DELETE FROM transactions WHERE id = $1`, [oldDelTx.rows[0].id]);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true, message: 'Закупка обновлена' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // СОЗДАНИЕ НОВОЙ ЗАКУПКИ (POST + РАСЧЕТ СРЕДНЕЙ ЦЕНЫ)
    // ------------------------------------------------------------------
    router.post('/api/inventory/purchase', requireAdmin, async (req, res) => {
        const { itemId, quantity, pricePerUnit, counterparty_id, account_id, purchaseDate, totalCost: frontendTotal, deliveryCost, deliveryAccountId } = req.body;

        if (!itemId || !counterparty_id) return res.status(400).json({ error: 'Не указан товар или поставщик!' });
        const qtyNum = Number(new Big(quantity || 0));
        const priceNum = Number(new Big(pricePerUnit || 0));
        const delCostNum = Number(new Big(deliveryCost || 0));

        if (isNaN(qtyNum) || qtyNum <= 0) return res.status(400).json({ error: 'Количество должно быть положительным!' });

        try {
            await withTransaction(pool, async (client) => {
                const materialsWh = await getWhId(client, 'materials');
                const materialCost = frontendTotal ? new Big(frontendTotal).toFixed(2) : new Big(qtyNum).times(priceNum).toFixed(2);
                const totalAmount = new Big(materialCost).plus(delCostNum).toFixed(2);

                // --- МАГИЯ СРЕДНЕВЗВЕШЕННОЙ СТОИМОСТИ (POST) ---
                const stockRes = await client.query(`SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`, [itemId, materialsWh]);
                const currentBalance = new Big(stockRes.rows[0].balance || 0);

                const itemRes = await client.query(`SELECT current_price FROM items WHERE id = $1 FOR UPDATE`, [itemId]);
                const currentPrice = new Big(itemRes.rows[0].current_price || 0);

                const newQtyBig = new Big(qtyNum);

                let newAvgPrice = new Big(0);
                if (currentBalance.lte(0)) {
                    // Если склад пуст, средняя цена = цене новой партии
                    newAvgPrice = new Big(totalAmount).div(newQtyBig);
                } else {
                    // (Стоимость всего старого запаса + Стоимость новой партии) / (Новый общий объем)
                    const currentTotalValue = currentBalance.times(currentPrice);
                    newAvgPrice = currentTotalValue.plus(totalAmount).div(currentBalance.plus(newQtyBig));
                }

                // Перезаписываем справочную цену
                await client.query(`UPDATE items SET current_price = $1 WHERE id = $2`, [newAvgPrice.toFixed(2), itemId]);
                // ----------------------------------------------

                const moveRes = await client.query(`
                    INSERT INTO inventory_movements 
                    (item_id, quantity, movement_type, warehouse_id, supplier_id, amount, delivery_cost, description, movement_date)
                    VALUES ($1, $2, 'purchase', $3, $4, $5, $6, $7, COALESCE($8::timestamp, CURRENT_TIMESTAMP)) RETURNING id
                `, [itemId, qtyNum, materialsWh, counterparty_id, totalAmount, delCostNum, `Закупка сырья (Мат: ${materialCost}, Дост: ${delCostNum})`, purchaseDate || null]);

                if (account_id) {
                    await client.query(`INSERT INTO transactions (account_id, amount, transaction_type, category, description, counterparty_id, payment_method, source_module, created_at, linked_purchase_id) VALUES ($1, $2, 'expense', 'Закупка сырья', $3, $4, 'Безналичный расчет', 'purchase', COALESCE($5::timestamp, CURRENT_TIMESTAMP), $6)`, [account_id, materialCost, `Оплата закупки (движение склада #${moveRes.rows[0].id})`, counterparty_id, purchaseDate || null, moveRes.rows[0].id]);
                }
                if (delCostNum > 0 && deliveryAccountId) {
                    await client.query(`INSERT INTO transactions (account_id, amount, transaction_type, category, description, counterparty_id, payment_method, source_module, created_at, linked_purchase_id) VALUES ($1, $2, 'expense', 'Транспортные расходы', $3, $4, 'Безналичный расчет', 'purchase', COALESCE($5::timestamp, CURRENT_TIMESTAMP), $6)`, [deliveryAccountId, delCostNum, `Оплата доставки (движение склада #${moveRes.rows[0].id})`, counterparty_id, purchaseDate || null, moveRes.rows[0].id]);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });




    // ------------------------------------------------------------------
    // ПОЛУЧЕНИЕ ДЕТАЛЕЙ ЗАКУПКИ (ДЛЯ РЕДАКТИРОВАНИЯ)
    // ------------------------------------------------------------------
    router.get('/api/inventory/purchase/:id', async (req, res) => {
        try {
            const purchaseId = req.params.id;

            const moveRes = await pool.query(`
                SELECT item_id, supplier_id, quantity, amount, COALESCE(delivery_cost, 0) as delivery_cost, to_char(created_at, 'YYYY-MM-DD') as purchase_date
                FROM inventory_movements 
                WHERE id = $1 AND movement_type = 'purchase'
            `, [purchaseId]);

            if (moveRes.rows.length === 0) return res.status(404).json({ error: 'Закупка не найдена' });

            // Ищем транзакцию за сам материал
            const txMatRes = await pool.query(`
                SELECT account_id FROM transactions 
                WHERE source_module = 'purchase' AND description LIKE $1 AND category = 'Закупка сырья'
            `, [`%движение склада #${purchaseId})%`]);

            // Ищем транзакцию за доставку
            const txDelRes = await pool.query(`
                SELECT account_id FROM transactions 
                WHERE source_module = 'purchase' AND description LIKE $1 AND category = 'Транспортные расходы'
            `, [`%движение склада #${purchaseId})%`]);

            const data = moveRes.rows[0];
            const matAmountBig = new Big(data.amount || 0).minus(new Big(data.delivery_cost || 0));
            const price = matAmountBig.div(new Big(data.quantity || 1)).toFixed(2);

            res.json({
                item_id: data.item_id,
                supplier_id: data.supplier_id,
                account_id: txMatRes.rows.length > 0 ? txMatRes.rows[0].account_id : '',
                quantity: data.quantity,
                price: price,
                purchase_date: data.purchase_date,
                delivery_cost: data.delivery_cost,
                delivery_account_id: txDelRes.rows.length > 0 ? txDelRes.rows[0].account_id : ''
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });


    // ------------------------------------------------------------------
    // ГЛОБАЛЬНЫЙ ПОИСК ЗАКУПОК (OMNIBOX)
    // ------------------------------------------------------------------
    router.get('/api/inventory/purchase-search', async (req, res) => {
        const { q } = req.query;
        if (!q || q.length < 2) return res.json([]);

        try {
            const searchPattern = `%${q}%`;
            // Ищем по материалам, поставщикам и ИНН. Считаем чистую цену без доставки.
            const query = `
                SELECT 
                    im.id, 
                    i.name as item_name, 
                    i.unit, 
                    c.name as supplier_name, 
                    im.quantity, 
                    (im.amount - COALESCE(im.delivery_cost, 0)) / im.quantity as price, 
                    im.amount, 
                    to_char(im.created_at, 'YYYY-MM-DD') as purchase_date
                FROM inventory_movements im
                JOIN items i ON im.item_id = i.id
                LEFT JOIN counterparties c ON im.supplier_id = c.id
                WHERE im.movement_type = 'purchase'
                  AND (i.name ILIKE $1 OR c.name ILIKE $1 OR c.inn ILIKE $1)
                ORDER BY im.created_at DESC
                LIMIT 50
            `;
            const result = await pool.query(query, [searchPattern]);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // АНАЛИЗ СЕБЕСТОИМОСТИ ДЛЯ ПРОДАЖ (ТЕОРИЯ VS ОПЫТ)
    // ------------------------------------------------------------------
    router.get('/api/sales/cost-analysis/:productId', async (req, res) => {
        const { productId } = req.params;
        try {
            // 1. ТЕОРЕТИЧЕСКАЯ СЕБЕСТОИМОСТЬ СЫРЬЯ (ПО РЕЦЕПТУ)
            const recipeRes = await pool.query(`
                SELECT r.material_id, r.quantity_per_unit as qty, i.current_price, i.name, i.unit
                FROM recipes r
                JOIN items i ON r.material_id = i.id
                WHERE r.product_id = $1
            `, [productId]);

            let theoreticalCost = new Big(0);
            let materialsMap = {}; // Карта для слияния Теории и Факта

            recipeRes.rows.forEach(r => {
                theoreticalCost = theoreticalCost.plus(new Big(r.qty).times(r.current_price || 0));
                materialsMap[r.material_id] = {
                    id: r.material_id,
                    name: r.name,
                    unit: r.unit,
                    theory_qty: Number(new Big(r.qty || 0)),
                    theory_cost: Number(new Big(r.qty || 0).times(r.current_price || 0)),
                    current_price: Number(new Big(r.current_price || 0)),
                    fact_qty: 0,
                    fact_cost: 0
                };
            });

            // 2. БАЗОВЫЕ ДАННЫЕ ПРОДУКЦИИ (Нужны для поддонов и теории)
            const itemRes = await pool.query(`SELECT mold_id, COALESCE(qty_per_cycle, 1) as qty_per_cycle FROM items WHERE id = $1`, [productId]);
            let qtyPerCycle = 1;
            let moldId = null;
            if (itemRes.rows.length > 0) {
                qtyPerCycle = Number(new Big(itemRes.rows[0].qty_per_cycle || 1));
                moldId = itemRes.rows[0].mold_id;
            }

            // 🚀 НОВОЕ: ДОСТАЕМ ОВЕРХЕД И ДЕЛИМ НА КОЭФФИЦИЕНТ ПОДДОНА
            const overheadRes = await pool.query(`SELECT value FROM settings WHERE key = 'overhead_per_cycle'`);
            const overheadPerCycle = overheadRes.rows.length > 0 ? Number(new Big(overheadRes.rows[0].value || 0)) : 0;
            const overheadPerUnit = qtyPerCycle > 0 ? (overheadPerCycle / qtyPerCycle) : 0;

            // 3. АМОРТИЗАЦИЯ ПОДДОНОВ
            let palletAmort = 0;
            const palletsRes = await pool.query(`SELECT purchase_cost, planned_cycles FROM equipment WHERE equipment_type = 'pallets' AND status = 'active' ORDER BY id ASC LIMIT 1`);
            if (palletsRes.rows.length > 0) {
                const cost = Number(new Big(palletsRes.rows[0].purchase_cost || 0));
                const cycles = Number(new Big(palletsRes.rows[0].planned_cycles || 1));
                if (cycles > 0) palletAmort = cost / (cycles * qtyPerCycle);
            }

            // 4. ОПЫТНАЯ СЕБЕСТОИМОСТЬ И ДЕТАЛИЗАЦИЯ (ПО 10 ПОСЛЕДНИМ ПАРТИЯМ)
            const historyRes = await pool.query(`
                SELECT id, planned_quantity,
                       ((machine_amort_cost + mold_amort_cost) / NULLIF(planned_quantity, 0)) as unit_amort
                FROM production_batches
                WHERE product_id = $1 AND status = 'completed'
                ORDER BY created_at DESC LIMIT 10
            `, [productId]);

            let empiricalMatCost = new Big(0);
            let avgAmort = new Big(palletAmort);

            if (historyRes.rows.length > 0) {
                let sumAmort = new Big(0);
                let totalProduced = new Big(0);
                const batchIds = [];

                historyRes.rows.forEach(row => {
                    sumAmort = sumAmort.plus(row.unit_amort || 0);
                    totalProduced = totalProduced.plus(row.planned_quantity || 0);
                    batchIds.push(row.id);
                });

                avgAmort = avgAmort.plus(sumAmort.div(historyRes.rows.length));

                // ДОСТАЕМ ДЕТАЛЬНЫЙ ФАКТ РАСХОДА МАТЕРИАЛОВ
                if (batchIds.length > 0 && totalProduced.gt(0)) {
                    const factMatRes = await pool.query(`
                        SELECT 
                            m.item_id, 
                            i.name, 
                            i.unit, 
                            SUM(ABS(m.quantity)) as total_fact_qty, 
                            SUM(ABS(m.quantity) * COALESCE(NULLIF(m.unit_price, 0), i.current_price)) as total_fact_cost
                        FROM inventory_movements m 
                        JOIN items i ON m.item_id = i.id 
                        WHERE m.batch_id = ANY($1::int[]) AND m.movement_type = 'production_expense'
                        GROUP BY m.item_id, i.name, i.unit
                    `, [batchIds]);

                    factMatRes.rows.forEach(f => {
                        const factQtyPerUnit = new Big(f.total_fact_qty).div(totalProduced).toNumber();
                        const factCostPerUnit = new Big(f.total_fact_cost).div(totalProduced).toNumber();

                        if (materialsMap[f.item_id]) {
                            materialsMap[f.item_id].fact_qty = factQtyPerUnit;
                            materialsMap[f.item_id].fact_cost = factCostPerUnit;
                        } else {
                            materialsMap[f.item_id] = {
                                id: f.item_id, name: f.name, unit: f.unit,
                                theory_qty: 0, theory_cost: 0,
                                current_price: (Number(new Big(f.total_fact_qty || 0)) > 0) ? new Big(f.total_fact_cost).div(f.total_fact_qty).toNumber() : 0,
                                fact_qty: factQtyPerUnit, fact_cost: factCostPerUnit
                            };
                        }
                    });
                }

                // 🚀 ГИБРИДНЫЙ РАСЧЕТ: ПОДСТРАХОВКА ДЛЯ УПАКОВКИ И ПРОЧЕГО
                let recalcEmpirical = new Big(0);
                Object.values(materialsMap).forEach(m => {
                    if (m.fact_qty === 0 && m.theory_qty > 0) {
                        m.fact_qty = m.theory_qty;
                        m.fact_cost = m.theory_cost;
                        m.is_hybrid = true; // Метка для фронтенда
                    }
                    recalcEmpirical = recalcEmpirical.plus(m.fact_cost);
                });
                // Заменяем котловую сумму на точную, собранную по крупицам
                empiricalMatCost = recalcEmpirical;

            } else {
                // Если нет опыта — считаем теорию амортизации
                let theoryAmort = 0;
                if (moldId) {
                    const moldRes = await pool.query(`SELECT purchase_cost, planned_cycles FROM equipment WHERE id = $1`, [moldId]);
                    if (moldRes.rows.length > 0) {
                        const m = moldRes.rows[0];
                        const cost = Number(new Big(m.purchase_cost || 0));
                        const cycles = Number(new Big(m.planned_cycles || 1));
                        if (cycles > 0) theoryAmort += cost / (cycles * qtyPerCycle);
                    }
                }
                const machineRes = await pool.query(`SELECT purchase_cost, planned_cycles FROM equipment WHERE equipment_type = 'machine' AND status = 'active' ORDER BY id ASC LIMIT 1`);
                if (machineRes.rows.length > 0) {
                    const m = machineRes.rows[0];
                    const cost = Number(new Big(m.purchase_cost || 0));
                    const cycles = Number(new Big(m.planned_cycles || 1));
                    if (cycles > 0) theoryAmort += cost / (cycles * qtyPerCycle);
                }
                avgAmort = avgAmort.plus(theoryAmort);
            }

            res.json({
                theoretical: theoreticalCost.toFixed(2),
                empirical: empiricalMatCost.toFixed(2),
                amortization: avgAmort.toFixed(2),
                overhead: overheadPerUnit.toFixed(2),
                materials: Object.values(materialsMap),
                batchCount: historyRes.rows.length
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // ПОЛУЧЕНИЕ ФИНАНСОВЫХ НАСТРОЕК (НАЛОГ И ОВЕРХЕД) ДЛЯ ДАШБОРДА
    // ------------------------------------------------------------------
    router.get('/api/settings/finance', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT key, value FROM settings 
                WHERE key IN ('sales_tax', 'monthly_expenses', 'working_days', 'cycles_per_shift', 'overhead_per_cycle')
            `);

            const settings = {};
            result.rows.forEach(row => { settings[row.key] = row.value; });

            res.json({
                sales_tax: settings.sales_tax || 6,
                monthly_expenses: settings.monthly_expenses || 1500000,
                working_days: settings.working_days || 22,
                cycles_per_shift: settings.cycles_per_shift || 500,
                overhead_per_cycle: settings.overhead_per_cycle || 136.36
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // СОХРАНЕНИЕ ФИНАНСОВЫХ НАСТРОЕК С ДАШБОРДА
    // ------------------------------------------------------------------
    router.post('/api/settings/finance', requireAdmin, async (req, res) => {
        const keys = ['sales_tax', 'monthly_expenses', 'working_days', 'cycles_per_shift', 'overhead_per_cycle'];

        try {
            await withTransaction(pool, async (client) => {
                for (let key of keys) {
                    if (req.body[key] !== undefined) {
                        await client.query(`
                            INSERT INTO settings (key, value) VALUES ($1, $2)
                            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                        `, [key, req.body[key]]);
                    }
                }
            });
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 8. УПРАВЛЕНИЕ РЕЗЕРВАМИ: Снятие / Переброска
    // ------------------------------------------------------------------
    router.post('/api/inventory/reserve-action', requireAdmin, async (req, res) => {
        const { action, itemId, batchId, linkedOrderItemId, qty, targetOrderItemId } = req.body;

        if (!action || !itemId || !qty || qty <= 0) {
            return res.status(400).json({ error: 'Некорректные параметры запроса.' });
        }

        try {
            await withTransaction(pool, async (client) => {
                const reserveWhId = await getWhId(client, 'reserve');
                const finishedWhId = await getWhId(client, 'finished');
                const qtyBig = new Big(qty);

                // Проверяем остаток в резерве
                let stockQuery = `SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`;
                const stockParams = [itemId, reserveWhId];
                if (linkedOrderItemId) { stockQuery += ` AND linked_order_item_id = $3`; stockParams.push(linkedOrderItemId); }
                if (batchId) { stockQuery += ` AND batch_id = $${stockParams.length + 1}`; stockParams.push(batchId); }
                const stockRes = await client.query(stockQuery, stockParams);
                const available = Number(new Big(stockRes.rows[0].balance || 0));

                if (Number(qtyBig) > available) {
                    throw new Error(`Недостаточно товара в резерве. Доступно: ${available}, запрошено: ${qty}`);
                }

                const qtyFixed = qtyBig.toFixed(4);

                if (action === 'release') {
                    // === СНЯТИЕ РЕЗЕРВА: WH7 -> WH4 ===
                    await client.query(
                        `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, linked_order_item_id)
                         VALUES ($1, $2, 'reserve_release_expense', $3, $4, $5, $6)`,
                        [itemId, -Number(qtyFixed), 'Снятие резерва', reserveWhId, batchId || null, linkedOrderItemId || null]
                    );
                    await client.query(
                        `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id)
                         VALUES ($1, $2, 'reserve_release_receipt', $3, $4, $5)`,
                        [itemId, Number(qtyFixed), 'Снятие резерва: возврат в свободную продажу', finishedWhId, batchId || null]
                    );

                    // Синхронизация qty_reserved в старом заказе
                    if (linkedOrderItemId) {
                        await client.query(
                            `UPDATE client_order_items SET qty_reserved = GREATEST(COALESCE(qty_reserved, 0) - $1, 0) WHERE id = $2`,
                            [Number(qtyFixed), linkedOrderItemId]
                        );
                    }

                } else if (action === 'transfer') {
                    // === ПЕРЕБРОСКА НА ДРУГОЙ ЗАКАЗ: WH7(old) -> WH7(new) ===
                    if (!targetOrderItemId) throw new Error('Не указана целевая позиция заказа.');

                    // Списание со старого резерва
                    await client.query(
                        `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, linked_order_item_id)
                         VALUES ($1, $2, 'reserve_transfer_out', $3, $4, $5, $6)`,
                        [itemId, -Number(qtyFixed), 'Переброска резерва', reserveWhId, batchId || null, linkedOrderItemId || null]
                    );
                    // Приход на новый резерв
                    await client.query(
                        `INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, linked_order_item_id)
                         VALUES ($1, $2, 'reserve_transfer_in', $3, $4, $5, $6)`,
                        [itemId, Number(qtyFixed), 'Переброска резерва', reserveWhId, batchId || null, targetOrderItemId]
                    );

                    // Синхронизация qty_reserved у ОБОИХ заказов
                    if (linkedOrderItemId) {
                        await client.query(
                            `UPDATE client_order_items SET qty_reserved = GREATEST(COALESCE(qty_reserved, 0) - $1, 0) WHERE id = $2`,
                            [Number(qtyFixed), linkedOrderItemId]
                        );
                    }
                    await client.query(
                        `UPDATE client_order_items SET qty_reserved = COALESCE(qty_reserved, 0) + $1 WHERE id = $2`,
                        [Number(qtyFixed), targetOrderItemId]
                    );

                } else {
                    throw new Error('Неизвестное действие: ' + action);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true, message: action === 'release' ? 'Резерв снят, товар возвращён на Склад №4' : 'Резерв переброшен на другой заказ' });
        } catch (err) {
            console.error(err);
            res.status(400).json({ error: err.message });
        }
    });

    // ------------------------------------------------------------------
    // 9. СПИСОК АКТИВНЫХ ПОЗИЦИЙ ЗАКАЗОВ (для селекта переброски)
    // ------------------------------------------------------------------
    router.get('/api/inventory/active-order-items', async (req, res) => {
        const { itemId } = req.query;
        try {
            const result = await pool.query(`
                SELECT coi.id, coi.order_id, co.doc_number, coi.qty_ordered, coi.qty_reserved, coi.qty_shipped,
                       c.name as client_name
                FROM client_order_items coi
                JOIN client_orders co ON coi.order_id = co.id
                LEFT JOIN counterparties c ON co.counterparty_id = c.id
                WHERE coi.item_id = $1 AND co.status IN ('pending', 'processing')
                ORDER BY co.created_at DESC
            `, [itemId]);
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Ошибка получения заказов.' });
        }
    });

    return router;
};