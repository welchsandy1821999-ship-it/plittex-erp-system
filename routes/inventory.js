// === ФАЙЛ: routes/inventory.js (Бэкенд-маршруты для модуля Склада) ===

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const Big = require('big.js');
const { sendNotify } = require('../utils/telegram');
const ExcelJS = require('exceljs');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { randomUUID } = require('crypto');

// 👈 Добавили withTransaction третьим аргументом
module.exports = function (pool, getWhId, withTransaction) {
    const { requireAdmin } = require('../middleware/auth');
    const { validatePurchase, validateSifting, validateScrap, validateAudit, validateReserveAction } = require('../middleware/validator');

    // ------------------------------------------------------------------
    // ИНВЕНТАРИЗАЦИЯ: ПЕЧАТЬ БЛАНКА (HTML)
    // ------------------------------------------------------------------
    router.get('/api/inventory/print', requireAdmin, async (req, res) => {
        try {
            const { mode, wh, as_of_date } = req.query; // mode: 'blind' / 'full', wh: 'all' / '4' / etc
            
            let queryOptions = "WHERE w.type IN ('materials', 'drying', 'finished', 'defect', 'markdown')";
            const params = [];
            
            if (wh && wh !== 'all') {
                params.push(wh);
                queryOptions += ` AND w.id = $${params.length}`;
            }

            if (as_of_date) {
                params.push(as_of_date);
                queryOptions += ` AND m.movement_date::date <= $${params.length}::date`;
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
            logger.error(err);
            res.status(500).send('Внутренняя ошибка сервера при формировании бланка.');
        }
    });

    // ------------------------------------------------------------------
    // ИНВЕНТАРИЗАЦИЯ: ЭКСПОРТ В EXCEL
    // ------------------------------------------------------------------
    router.get('/api/inventory/export', requireAdmin, async (req, res) => {
        try {
            const { mode, wh, as_of_date } = req.query; // 'blind' или 'full'
            
            let queryOptions = "WHERE w.type IN ('materials', 'drying', 'finished', 'defect', 'markdown')";
            const params = [];
            
            if (wh && wh !== 'all') {
                params.push(wh);
                queryOptions += ` AND w.id = $${params.length}`;
            }

            if (as_of_date) {
                params.push(as_of_date);
                queryOptions += ` AND m.movement_date::date <= $${params.length}::date`;
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
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Ошибка обработки файла' });
        }
    });

    // ------------------------------------------------------------------
    // ПОЛУЧЕНИЕ ДАТ СОБЫТИЙ СУШИЛКИ (ДЛЯ ДВУХЦВЕТНЫХ ТОЧЕК КАЛЕНДАРЯ)
    // ------------------------------------------------------------------
    router.get('/api/inventory/drying-dates', async (req, res) => {
        try {
            const dryingWh = await getWhId(pool, 'drying');

            const receipts = await pool.query(`
                SELECT DISTINCT to_char(movement_date, 'YYYY-MM-DD') as date
                FROM inventory_movements
                WHERE warehouse_id = $1 AND movement_type = 'production_receipt'
                ORDER BY date DESC
            `, [dryingWh]);

            const expenses = await pool.query(`
                SELECT DISTINCT to_char(movement_date, 'YYYY-MM-DD') as date
                FROM inventory_movements
                WHERE warehouse_id = $1 AND movement_type = 'wip_expense'
                ORDER BY date DESC
            `, [dryingWh]);

            res.json({
                receiptDates: receipts.rows.map(r => r.date),
                expenseDates: expenses.rows.map(r => r.date)
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
        }
    });

    // ------------------------------------------------------------------
    // ИСТОРИЯ ДВИЖЕНИЙ СУШИЛКИ ЗА ДАТУ (ДЛЯ БЛОКА «ИСТОРИЯ РАСПАЛУБКИ»)
    // ------------------------------------------------------------------
    router.get('/api/inventory/drying-history', async (req, res) => {
        try {
            const { date } = req.query;
            if (!date) return res.status(400).json({ error: 'Параметр date обязателен' });

            const dryingWh = await getWhId(pool, 'drying');

            const result = await pool.query(`
                SELECT 
                    im.id,
                    im.movement_type,
                    im.quantity,
                    im.description,
                    to_char(im.movement_date, 'HH24:MI') as time,
                    i.name as product_name,
                    i.unit,
                    pb.batch_number,
                    im.batch_id
                FROM inventory_movements im
                JOIN items i ON im.item_id = i.id
                LEFT JOIN production_batches pb ON im.batch_id = pb.id
                WHERE im.warehouse_id = $1 AND im.movement_date::date = $2::date
                ORDER BY im.movement_date DESC
            `, [dryingWh, date]);

            res.json(result.rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
        }
    });

    // ------------------------------------------------------------------
    // КАРТОЧКА ПРОСЛЕЖИВАЕМОСТИ ПАРТИИ (BATCH TRACEABILITY CARD)
    // ------------------------------------------------------------------
    router.get('/api/inventory/batch/:id/card', async (req, res) => {
        try {
            const batchId = parseInt(req.params.id);
            if (isNaN(batchId)) return res.status(400).json({ error: 'Некорректный ID' });

            // 1. Основные данные партии
            const batchRes = await pool.query(`
                SELECT pb.*, i.name as product_name, i.unit as product_unit
                FROM production_batches pb
                JOIN items i ON pb.product_id = i.id
                WHERE pb.id = $1
            `, [batchId]);
            if (batchRes.rows.length === 0) return res.status(404).json({ error: 'Партия не найдена' });
            const batch = batchRes.rows[0];

            // 2. Все движения по партии
            const movRes = await pool.query(`
                SELECT im.id, im.movement_type, im.quantity, im.description,
                    to_char(im.movement_date, 'DD.MM.YYYY HH24:MI') as date_fmt,
                    im.warehouse_id, w.name as warehouse_name, w.type as warehouse_type,
                    i.name as item_name, i.unit
                FROM inventory_movements im
                JOIN items i ON im.item_id = i.id
                LEFT JOIN warehouses w ON im.warehouse_id = w.id
                WHERE im.batch_id = $1
                ORDER BY im.movement_date ASC
            `, [batchId]);
            const movements = movRes.rows;

            // 3. Материалы (expenses)
            const matRes = await pool.query(`
                SELECT i.name, i.unit, SUM(ABS(im.quantity)) as qty,
                    SUM(ABS(im.quantity) * CASE WHEN im.unit_price > 0 THEN im.unit_price ELSE i.current_price END) as cost
                FROM inventory_movements im
                JOIN items i ON im.item_id = i.id
                WHERE im.batch_id = $1 AND im.movement_type IN ('production_expense', 'production_draft')
                GROUP BY i.name, i.unit ORDER BY cost DESC
            `, [batchId]);

            // 4. Вход/Выход из сушилки
            const dryingWh = await getWhId(pool, 'drying');
            const finishedWh = await getWhId(pool, 'finished');
            const markdownWh = await getWhId(pool, 'markdown');
            const defectWh = await getWhId(pool, 'defect');

            let totalIn = 0, totalOut = 0, grade1 = 0, grade2 = 0, scrap = 0;
            for (const m of movements) {
                const qty = parseFloat(m.quantity) || 0;
                if (m.warehouse_id === dryingWh && m.movement_type === 'production_receipt' && qty > 0) totalIn += qty;
                if (m.warehouse_id === dryingWh && m.movement_type === 'wip_expense' && qty < 0) totalOut += Math.abs(qty);
                if (m.warehouse_id === finishedWh && m.movement_type === 'finished_receipt' && qty > 0) grade1 += qty;
                if (m.warehouse_id === markdownWh && m.movement_type === 'markdown_receipt' && qty > 0) grade2 += qty;
                if (m.warehouse_id === defectWh && m.movement_type === 'defect_receipt' && qty > 0) scrap += qty;
            }

            const remaining = Math.max(totalIn - totalOut, 0);
            const progressPct = totalIn > 0 ? Math.min(Math.round((totalOut / totalIn) * 100), 100) : 0;
            const isClosed = totalOut >= totalIn - 0.01 && totalIn > 0;
            const grade1Pct = totalIn > 0 && grade1 > 0 ? Math.round((grade1 / totalIn) * 100) : null;

            // 5. Возраст в сушилке
            const prodDate = batch.production_date || batch.created_at;
            const ageDays = Math.floor((Date.now() - new Date(prodDate).getTime()) / 86400000);

            // 6. Связь с заказом (через planned_production)
            let orderInfo = null;
            try {
                const orderRes = await pool.query(`
                    SELECT co.doc_number, co.status, co.total_amount, cp.name as client_name
                    FROM planned_production pp
                    JOIN client_order_items coi ON pp.order_item_id = coi.id
                    JOIN client_orders co ON coi.order_id = co.id
                    LEFT JOIN counterparties cp ON co.counterparty_id = cp.id
                    WHERE pp.item_id = $1
                    ORDER BY pp.id DESC LIMIT 1
                `, [batch.product_id]);
                if (orderRes.rows.length > 0) orderInfo = orderRes.rows[0];
            } catch (e) { /* planned_production может не существовать */ }

            // 7. Себестоимость
            const matCost = parseFloat(batch.mat_cost_total) || 0;
            const machineCost = parseFloat(batch.machine_amort_cost) || 0;
            const moldCost = parseFloat(batch.mold_amort_cost) || 0;
            const totalCost = matCost + machineCost + moldCost;
            const plannedQty = parseFloat(batch.planned_quantity) || 1;
            const unitCost = totalCost / plannedQty;

            res.json({
                batch: {
                    id: batch.id, batch_number: batch.batch_number,
                    product_name: batch.product_name, product_unit: batch.product_unit,
                    planned_quantity: plannedQty, status: batch.status,
                    production_date: batch.production_date, created_at: batch.created_at,
                    shift_name: batch.shift_name,
                    costs: { materials: matCost, machine_amort: machineCost, mold_amort: moldCost, total: totalCost, per_unit: Math.round(unitCost * 100) / 100 }
                },
                order: orderInfo,
                drying: { age_days: ageDays, total_in: totalIn, total_out: totalOut, remaining, progress_pct: progressPct },
                outputs: { grade1, grade2, scrap },
                movements: movements.map(m => ({
                    id: m.id, date: m.date_fmt, type: m.movement_type,
                    warehouse_name: m.warehouse_name, quantity: parseFloat(m.quantity),
                    item_name: m.item_name, unit: m.unit
                })),
                materials: matRes.rows.map(m => ({ name: m.name, unit: m.unit, qty: parseFloat(m.qty), cost: parseFloat(m.cost) || 0 })),
                analytics: { grade1_yield_pct: grade1Pct, is_closed: isClosed }
            });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
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
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // ПОСТАВЩИКИ ДЛЯ МАТЕРИАЛА (кто ранее поставлял данное сырье)
    // ------------------------------------------------------------------
    router.get('/api/inventory/material-suppliers/:id', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT im.supplier_id, MAX(im.movement_date) as last_date
                FROM inventory_movements im
                WHERE im.item_id = $1 AND im.movement_type = 'purchase' AND im.supplier_id IS NOT NULL
                GROUP BY im.supplier_id
                ORDER BY last_date DESC
            `, [req.params.id]);
            res.json(result.rows.map(r => r.supplier_id));
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка сервера' });
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
                SELECT (amount / NULLIF(quantity, 0)) as last_price, to_char(movement_date, 'DD.MM.YYYY') as last_date
                FROM inventory_movements
                WHERE item_id = $1 AND movement_type = 'purchase'
                ORDER BY movement_date DESC
                LIMIT 1
            `, [itemId]);

            res.json({
                balance: stockRes.rows[0]?.balance || 0,
                lastPrice: lastPurchaseRes.rows[0]?.last_price || null,
                lastDate: lastPurchaseRes.rows[0]?.last_date || null
            });
        } catch (err) {
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    router.get('/api/inventory', async (req, res) => {
        try {
            const { as_of_date } = req.query;
            let whereClause = '';
            const params = [];
            
            if (as_of_date) {
                whereClause = 'WHERE m.movement_date::date <= $1::date';
                params.push(as_of_date);
            }

            let selectPart = '';
            let groupPart = '';
            
            if (req.query.aggregate === 'true') {
                selectPart = `
                    m.item_id, i.name as item_name, i.unit, 
                    m.warehouse_id, w.name as warehouse_name, w.type as warehouse_type,
                    NULL as batch_id, 
                    'Агрегировано' as batch_number, 
                    NULL as linked_order_item_id,
                    NULL as order_doc_number,
                    NULL as order_id,
                    NULL as batch_status,
                    SUM(m.quantity) as total 
                `;
                groupPart = `
                    m.item_id, i.name, i.unit, 
                    m.warehouse_id, w.name, w.type
                `;
            } else {
                selectPart = `
                    m.item_id, i.name as item_name, i.unit, 
                    m.warehouse_id, w.name as warehouse_name, w.type as warehouse_type,
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE m.batch_id END as batch_id, 
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE b.batch_number END as batch_number, 
                    CASE WHEN w.type = 'reserve' THEN m.linked_order_item_id ELSE NULL END as linked_order_item_id,
                    CASE WHEN w.type = 'reserve' THEN co.doc_number ELSE NULL END as order_doc_number,
                    CASE WHEN w.type = 'reserve' THEN co.id ELSE NULL END as order_id,
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE b.status END as batch_status,
                    SUM(m.quantity) as total
                `;
                groupPart = `
                    m.item_id, i.name, i.unit, 
                    m.warehouse_id, w.name, w.type,
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE m.batch_id END, 
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE b.batch_number END,
                    CASE WHEN w.type = 'reserve' THEN m.linked_order_item_id ELSE NULL END,
                    CASE WHEN w.type = 'reserve' THEN co.doc_number ELSE NULL END,
                    CASE WHEN w.type = 'reserve' THEN co.id ELSE NULL END,
                    CASE WHEN w.type IN ('materials', 'reserve') THEN NULL ELSE b.status END
                `;
            }

            const result = await pool.query(`
                SELECT 
                    ${selectPart}
                FROM inventory_movements m
                JOIN items i ON m.item_id = i.id
                JOIN warehouses w ON m.warehouse_id = w.id
                LEFT JOIN production_batches b ON m.batch_id = b.id
                LEFT JOIN client_order_items coi ON w.type = 'reserve' AND m.linked_order_item_id = coi.id
                LEFT JOIN client_orders co ON coi.order_id = co.id
                ${whereClause}
                GROUP BY 
                    ${groupPart}
                ${req.query.showZeros === 'true' ? '' : 'HAVING SUM(m.quantity) <> 0'}
                ORDER BY w.name, i.name
            `, params);
            
            let rows = result.rows;

            res.json(rows);
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 2. МАРШРУТ: ПРОСЕИВАНИЕ (ПЕРЕРАБОТКА) СЫРЬЯ
    // ------------------------------------------------------------------
    router.post('/api/inventory/sifting', requireAdmin, validateSifting, async (req, res) => {
        const { sourceId, sourceQty, outputs, date } = req.body;
        // 🛡️ AUDIT-018: ad-hoc проверка удалена — покрыта validateSifting middleware

        try {
            await withTransaction(pool, async (client) => {
                const materialsWh = await getWhId(client, 'materials');
                
                // 1. Блокируем строки (физический уровень) для предотвращения race condition
                await client.query(`
                    SELECT id FROM inventory_movements 
                    WHERE item_id = $1 AND warehouse_id = $2 FOR UPDATE
                `, [sourceId, materialsWh]);

                // 2. Считаем агрегированный остаток (логический уровень) уже после блокировки
                const stockRes = await client.query(`
                    SELECT COALESCE(SUM(quantity), 0) as balance 
                    FROM inventory_movements 
                    WHERE item_id = $1 AND warehouse_id = $2
                `, [sourceId, materialsWh]);
                
                const available = Number(new Big(stockRes.rows[0].balance || 0));
                if (sourceQty > available) {
                    throw new Error(`Недостаточно сырья для просеивания. В наличии: ${available} кг`);
                }

                // 2. Списываем исходное сырье
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, movement_date)
                    VALUES ($1, $2, 'sifting_expense', $3, $4, COALESCE($5::timestamp, CURRENT_TIMESTAMP))
                `, [sourceId, -sourceQty, `Просеивание`, materialsWh, date || null]);

                // 3. Приходуем выходы
                for (let out of outputs) {
                    if (out.qty > 0) {
                        await client.query(`
                            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, movement_date)
                            VALUES ($1, $2, 'sifting_receipt', $3, $4, COALESCE($5::timestamp, CURRENT_TIMESTAMP))
                        `, [out.id, out.qty, `Из просеивания (исходник ID: ${sourceId})`, materialsWh, date || null]);
                    }
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');

            res.json({ success: true, message: 'Просеивание успешно выполнено' });
        } catch (err) {
            logger.error('SIFTING ERROR:', err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    // ------------------------------------------------------------------
    // X. МАРШРУТ: ИСТОРИЯ ДВИЖЕНИЯ ТОВАРА / КАРТОЧКА (GET /api/inventory/history/:itemId)
    // ------------------------------------------------------------------
    router.get('/api/inventory/history/:itemId', requireAdmin, async (req, res) => {
        const { itemId } = req.params;
        const { warehouse_id, start_date, end_date } = req.query;

        try {
            let filterConditions = [`m.item_id = $1`];
            let filterParams = [itemId];
            let paramIdx = 2;

            if (warehouse_id && warehouse_id !== 'all') {
                filterConditions.push(`m.warehouse_id = $${paramIdx}`);
                filterParams.push(warehouse_id);
                paramIdx++;
            }

            // Сальдо на начало
            let startBalance = 0;
            if (start_date) {
                const sbParams = [...filterParams];
                let sbConditions = [...filterConditions];
                
                sbConditions.push(`m.movement_date < $${paramIdx}`);
                sbParams.push(`${start_date} 00:00:00`);

                const sbRes = await pool.query(`
                    SELECT COALESCE(SUM(quantity), 0) as start_balance
                    FROM inventory_movements m
                    WHERE ${sbConditions.join(' AND ')}
                `, sbParams);
                startBalance = parseFloat(sbRes.rows[0].start_balance) || 0;
            }

            // Основная выборка движений
            if (start_date) {
                filterConditions.push(`m.movement_date >= $${paramIdx}`);
                filterParams.push(`${start_date} 00:00:00`);
                paramIdx++;
            }
            if (end_date) {
                filterConditions.push(`m.movement_date <= $${paramIdx}`);
                filterParams.push(`${end_date} 23:59:59`);
                paramIdx++;
            }

            const query = `
                SELECT 
                    m.movement_date as op_date,
                    m.item_id, i.name as item_name, i.unit as unit,
                    m.movement_type as movement_types,
                    m.batch_id, b.batch_number as batch_number,
                    m.user_id, u.username as user_name,
                    COALESCE(
                        m.order_id, 
                        coi.order_id,
                        (SELECT id FROM client_orders cmd WHERE cmd.doc_number = substring(m.description from 'ЗК-[0-9]+') LIMIT 1)
                    ) as order_id, 
                    COALESCE(
                        o.doc_number, 
                        o2.doc_number,
                        substring(m.description from 'ЗК-[0-9]+')
                    ) as order_doc,
                    m.supplier_id, c.name as supplier_name,
                    CASE WHEN m.quantity > 0 THEN m.quantity ELSE 0 END as qty_in,
                    CASE WHEN m.quantity < 0 THEN ABS(m.quantity) ELSE 0 END as qty_out,
                    m.quantity as balance_diff,
                    CASE WHEN m.quantity < 0 THEN w.name ELSE NULL END as warehouse_from,
                    CASE WHEN m.quantity > 0 THEN w.name ELSE NULL END as warehouse_to,
                    m.description,
                    m.unit_price as unit_price,
                    m.amount as amount
                FROM inventory_movements m
                LEFT JOIN items i ON m.item_id = i.id
                LEFT JOIN warehouses w ON m.warehouse_id = w.id
                LEFT JOIN production_batches b ON m.batch_id = b.id
                LEFT JOIN client_orders o ON m.order_id = o.id
                LEFT JOIN client_order_items coi ON m.linked_order_item_id = coi.id
                LEFT JOIN client_orders o2 ON coi.order_id = o2.id
                LEFT JOIN counterparties c ON m.supplier_id = c.id
                LEFT JOIN users u ON m.user_id = u.id
                WHERE ${filterConditions.join(' AND ')}
                ORDER BY m.movement_date ASC, m.id ASC
            `;

            const historyRes = await pool.query(query, filterParams);
            
            const itemRes = await pool.query('SELECT current_price FROM items WHERE id = $1', [itemId]);
            const currentPrice = itemRes.rows.length > 0 ? parseFloat(itemRes.rows[0].current_price) || 0 : 0;

            res.json({
                success: true,
                startBalance: startBalance,
                history: historyRes.rows,
                currentPrice: currentPrice
            });

        } catch (err) {
            logger.error('INVENTORY HISTORY ERROR:', err);
            res.status(500).json({ error: 'Ошибка сервера при получении истории движения' });
        }
    });

    // ------------------------------------------------------------------
    // 3. МАРШРУТ: СПИСАНИЕ В БРАК ИЛИ УТИЛЬ (POST /api/inventory/scrap)
    // ------------------------------------------------------------------
    router.post('/api/inventory/scrap', requireAdmin, validateScrap, async (req, res) => {
        const { itemId, batchId, warehouseId, targetWarehouseId, scrapQty, description } = req.body;

        try {
            // 👈 Используем безопасную транзакцию
            await withTransaction(pool, async (client) => {
                const defectWh = await getWhId(client, 'defect');
                const markdownWh = await getWhId(client, 'markdown');

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

                const trId = randomUUID();

                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, transaction_id)
                    VALUES ($1, $2, 'scrap_writeoff', $3, $4, $5, $6)
                `, [itemId, -Math.abs(scrapQty), description, warehouseId, batchId || null, trId]);

                // Трансформация в 2-й сорт, если летит на 5-й склад (Уценка)
                let targetItemId = itemId;
                
                if (parseInt(targetWarehouseId) === markdownWh) {
                    const origItemRes = await client.query('SELECT name, article, category, unit, current_price, item_type, weight_kg, qty_per_cycle, amortization_per_cycle, mold_id, gost_mark, dealer_price FROM items WHERE id = $1', [itemId]);
                    if (origItemRes.rows.length > 0) {
                        const orig = origItemRes.rows[0];
                        if (!orig.name.toLowerCase().includes('2 сорт') && !orig.name.toLowerCase().includes('2-й сорт') && !orig.name.toLowerCase().includes('2сорт')) {
                            const newName = `${orig.name.trim()} 2 сорт`;
                            const newArticle = orig.article ? `${orig.article.trim()}2S` : `${itemId}-2S`;
                            const newPrice = orig.current_price ? Number(new Big(orig.current_price).div(2).round(2)) : 0;
                            const newDealerPrice = orig.dealer_price ? Number(new Big(orig.dealer_price).div(2).round(2)) : 0;

                            const checkExistRes = await client.query('SELECT id FROM items WHERE name = $1 AND is_deleted = false LIMIT 1', [newName]);

                            if (checkExistRes.rows.length > 0) {
                                targetItemId = checkExistRes.rows[0].id;
                            } else {
                                const insertRes = await client.query(`
                                    INSERT INTO items (name, article, category, unit, current_price, dealer_price, item_type, is_deleted, weight_kg, qty_per_cycle, amortization_per_cycle, mold_id, gost_mark)
                                    VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, $12)
                                    RETURNING id
                                `, [newName, newArticle, orig.category, orig.unit, newPrice, newDealerPrice, orig.item_type, orig.weight_kg, orig.qty_per_cycle, orig.amortization_per_cycle, orig.mold_id, orig.gost_mark]);
                                targetItemId = insertRes.rows[0].id;
                            }
                        }
                    }
                }

                const destType = parseInt(targetWarehouseId) === defectWh ? 'defect_receipt' : 'markdown_receipt';
                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, transaction_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [targetItemId, Math.abs(scrapQty), destType, description, targetWarehouseId, batchId || null, trId]);
            });
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            sendNotify(`⚠️ <b>Списание в брак</b>\nКоличество: ${scrapQty}\nПричина: ${description || 'Не указана'}`);

            res.json({ success: true, message: 'Успешно перемещено' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // ИНВЕНТАРИЗАЦИЯ: КОРРЕКТИРОВКА ОСТАТКОВ (ИСПРАВЛЕННЫЙ БЕЗОПАСНЫЙ МЕТОД)
    // ------------------------------------------------------------------
    router.post('/api/inventory/audit', requireAdmin, validateAudit, async (req, res) => {
        const { warehouseId, adjustments, auditDate } = req.body;
        const userId = req.user ? req.user.id : null;

        try {
            await withTransaction(pool, async (client) => {
                for (const adj of adjustments) {
                    const { itemId, actualQty } = adj;
                    let batchId = adj.batchId;
                    const wh_id = adj.warehouseId || warehouseId;

                    const itemCheckRes = await client.query('SELECT item_type FROM items WHERE id = $1', [itemId]);
                    if (itemCheckRes.rows.length === 0) throw new Error(`Товар с ID ${itemId} не найден`);
                    const itemType = itemCheckRes.rows[0].item_type;

                    const whRes = await client.query('SELECT type FROM warehouses WHERE id = $1', [wh_id]);
                    if (whRes.rows.length === 0) throw new Error(`Склад с ID ${wh_id} не найден`);
                    const whType = whRes.rows[0].type;

                    // 0. Защита от пересортицы (Foolproof)
                    if ((whType === 'finished' || whType === 'defect') && itemType !== 'product' && itemType !== 'Продукция') {
                        throw new Error(`БЕЗОПАСНОСТЬ: Попытка добавить сырье/материал на склад готовой продукции заблокирована.`);
                    }
                    if (whType === 'materials' && (itemType === 'product' || itemType === 'Продукция')) {
                        throw new Error(`БЕЗОПАСНОСТЬ: Попытка добавить готовую продукцию на склад сырья заблокирована.`);
                    }

                    // АГРЕГИРОВАННАЯ РЕВИЗИЯ (FIFO)
                    const isAggregate = adj.aggregate === true || adj.aggregate === 'true' || !batchId;
                    
                    if (isAggregate && (whType === 'finished' || whType === 'defect')) {
                        // 1. Блокируем все строки для этого товара на складе
                        await client.query(`SELECT id FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2 FOR UPDATE`, [itemId, wh_id]);

                        // 2. Считаем общий остаток
                        let sumQuery = `SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`;
                        const sumParams = [itemId, wh_id];
                        if (auditDate) {
                            sumParams.push(auditDate);
                            sumQuery += ` AND movement_date::date <= $3::date`;
                        }
                        const stockRes = await client.query(sumQuery, sumParams);
                        const currentBalanceBig = new Big(stockRes.rows[0].balance || 0);
                        const currentBalance = Number(currentBalanceBig);

                        const diffQtyBig = new Big(actualQty || 0).minus(currentBalanceBig);
                        const diffQty = Number(diffQtyBig);

                        if (diffQtyBig.abs().gt(0.0001)) {
                            const dateStrPart = auditDate ? ` от ${auditDate}` : '';
                            const desc = `Инвентаризация (Свернуто)${dateStrPart}: факт ${actualQty}, было ${currentBalance}`;

                            if (diffQtyBig.gt(0)) {
                                // ИЗЛИШЕК (+) -> Кладем всё в системную партию
                                const batchName = 'Излишки инвентаризации от ' + (auditDate || new Date().toISOString().slice(0,10));
                                let surplusBatchId;
                                const existRes = await client.query(`SELECT id FROM production_batches WHERE product_id = $1 AND batch_number = $2`, [itemId, batchName]);
                                if (existRes.rows.length > 0) surplusBatchId = existRes.rows[0].id;
                                else {
                                    const bRes = await client.query(`INSERT INTO production_batches (batch_number, product_id, status, created_at) VALUES ($1, $2, 'completed', CURRENT_TIMESTAMP) RETURNING id`, [batchName, itemId]);
                                    surplusBatchId = bRes.rows[0].id;
                                }
                                await client.query(`
                                    INSERT INTO inventory_movements (item_id, warehouse_id, batch_id, quantity, movement_type, description, user_id, movement_date, created_at) 
                                    VALUES ($1, $2, $3, $4, 'audit_adjustment', $5, $6, COALESCE($7::timestamp, CURRENT_TIMESTAMP), COALESCE($7::timestamp, CURRENT_TIMESTAMP))
                                `, [itemId, wh_id, surplusBatchId, diffQty, desc, userId, auditDate || null]);
                            } else {
                                // НЕДОСТАЧА (-) -> FIFO Списание с самых старых партий
                                let batchesQuery = `
                                    SELECT m.batch_id, SUM(m.quantity) as qty, MIN(COALESCE(m.movement_date, m.created_at)) as first_date
                                    FROM inventory_movements m
                                    WHERE m.item_id = $1 AND m.warehouse_id = $2
                                `;
                                if (auditDate) batchesQuery += ` AND m.movement_date::date <= $3::date `;
                                batchesQuery += ` GROUP BY m.batch_id HAVING SUM(m.quantity) > 0 ORDER BY first_date ASC `;

                                const activeBatchesParams = auditDate ? [itemId, wh_id, auditDate] : [itemId, wh_id];
                                const activeBatchesRes = await client.query(batchesQuery, activeBatchesParams);

                                let remainingMinus = diffQtyBig.abs(); 

                                for (const ab of activeBatchesRes.rows) {
                                    if (remainingMinus.lte(0)) break; // Всё распределили

                                    const batchQtyBig = new Big(ab.qty);
                                    const toWriteOff = remainingMinus.gt(batchQtyBig) ? batchQtyBig : remainingMinus;
                                    
                                    await client.query(`
                                        INSERT INTO inventory_movements (item_id, warehouse_id, batch_id, quantity, movement_type, description, user_id, movement_date, created_at) 
                                        VALUES ($1, $2, $3, $4, 'audit_adjustment', $5, $6, COALESCE($7::timestamp, CURRENT_TIMESTAMP), COALESCE($7::timestamp, CURRENT_TIMESTAMP))
                                    `, [itemId, wh_id, ab.batch_id, Number(toWriteOff.times(-1)), desc, userId, auditDate || null]);

                                    remainingMinus = remainingMinus.minus(toWriteOff);
                                }
                                
                                if (remainingMinus.gt(0.0001)) {
                                    // Если физически не хватило объемов во всех партиях
                                    await client.query(`
                                        INSERT INTO inventory_movements (item_id, warehouse_id, batch_id, quantity, movement_type, description, user_id, movement_date, created_at) 
                                        VALUES ($1, $2, NULL, $3, 'audit_adjustment', $4, $5, COALESCE($6::timestamp, CURRENT_TIMESTAMP), COALESCE($6::timestamp, CURRENT_TIMESTAMP))
                                    `, [itemId, wh_id, Number(remainingMinus.times(-1)), desc + ' (без партии)', userId, auditDate || null]);
                                }
                            }
                        }
                        continue; // Переходим к следующей корректировке
                    }

                    // СТАНДАРТНАЯ РЕВИЗИЯ (ПОСТРОЧНО)
                    if (batchId === 'new') {
                        const batchName = 'Излишки инвентаризации от ' + (auditDate || new Date().toISOString().slice(0,10));
                        const existRes = await client.query(`SELECT id FROM production_batches WHERE product_id = $1 AND batch_number = $2`, [itemId, batchName]);
                        if (existRes.rows.length > 0) {
                            batchId = existRes.rows[0].id;
                        } else {
                            const bRes = await client.query(`INSERT INTO production_batches (batch_number, product_id, status, created_at) VALUES ($1, $2, 'completed', CURRENT_TIMESTAMP) RETURNING id`, [batchName, itemId]);
                            batchId = bRes.rows[0].id;
                        }
                    }

                    // 1. Сначала блокируем строки (FOR UPDATE)
                    let lockQuery = `
                        SELECT id FROM inventory_movements 
                        WHERE item_id = $1 AND warehouse_id = $2
                    `;
                    const lockParams = [itemId, wh_id];
                    
                    if (whType !== 'materials' && whType !== 'reserve') {
                        if (batchId) {
                            lockQuery += ` AND batch_id = $3`;
                            lockParams.push(batchId);
                        } else {
                            lockQuery += ` AND batch_id IS NULL`;
                        }
                    }

                    await client.query(lockQuery + " FOR UPDATE", lockParams);

                    // 2. Считаем сумму
                    let sumQuery = `
                        SELECT COALESCE(SUM(quantity), 0) as balance 
                        FROM inventory_movements 
                        WHERE item_id = $1 AND warehouse_id = $2
                    `;
                    let sumParams = [itemId, wh_id];
                    
                    if (whType !== 'materials' && whType !== 'reserve') {
                        if (batchId) {
                            sumQuery += ` AND batch_id = $3`;
                            sumParams.push(batchId);
                        } else {
                            sumQuery += ` AND batch_id IS NULL`;
                        }
                    }

                    if (auditDate) {
                        sumParams.push(auditDate);
                        sumQuery += ` AND movement_date::date <= $${sumParams.length}::date`;
                    }

                    const stockRes = await client.query(sumQuery, sumParams);
                    const currentBalanceBig = new Big(stockRes.rows[0].balance || 0);
                    const currentBalance = Number(currentBalanceBig);

                    // 3. Вычисляем дельту
                    const diffQtyBig = new Big(actualQty || 0).minus(currentBalanceBig);
                    const diffQty = Number(diffQtyBig);

                    // 4. Записываем корректировку
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 4. МАРШРУТ: РАСПАЛУБКА И ПРИЕМКА (POST /api/move-wip)
    // ------------------------------------------------------------------
    router.post('/api/move-wip', requireAdmin, async (req, res) => {
        const { batchId, tileId, currentWipQty, goodQty, grade2Qty, scrapQty, isComplete, movementDate } = req.body;

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

                // 🔒 Шаг 1: Мьютекс партии — блокируем строку в production_batches
                // (параллельный запрос встанет в очередь до конца транзакции)
                await client.query('SELECT id FROM production_batches WHERE id = $1 FOR UPDATE', [batchId]);

                // 🔒 Шаг 2: Читаем РЕАЛЬНЫЙ остаток (уже безопасно — партия заблокирована)
                const wipBalanceRes = await client.query(`
                    SELECT COALESCE(SUM(quantity), 0) as real_balance
                    FROM inventory_movements
                    WHERE batch_id = $1 AND warehouse_id = $2
                `, [batchId, dryingWh]);
                const realWipBalance = parseFloat(wipBalanceRes.rows[0].real_balance);

                // Защита от двойного клика: если партия уже пуста — отклоняем
                if (realWipBalance <= 0) {
                    throw new Error(`Партия #${batchId} уже полностью распалублена (остаток в сушилке: 0). Повторное списание невозможно.`);
                }

                // ✅ FIX (п.5): Округляем все qty до 2 знаков через Big.js ДО любых вычислений
                const safeGood = Number(new Big(goodQty || 0).round(2));
                const safeGrade2 = Number(new Big(grade2Qty || 0).round(2));
                const safeScrap = Number(new Big(scrapQty || 0).round(2));
                const reportedQty = Number(new Big(safeGood).plus(safeGrade2).plus(safeScrap).round(2));

                // ✅ FIX (п.3): Жесткое обнуление — isComplete списывает весь реальный остаток из БД
                const totalRemoved = isComplete ? realWipBalance : reportedQty;

                // Защита от перерасхода (только для частичной распалубки)
                if (!isComplete && totalRemoved > realWipBalance) {
                    throw new Error(
                        `Невозможно списать ${totalRemoved} ед. из сушилки (партия #${batchId}). ` +
                        `Реальный остаток: ${realWipBalance} ед. Возможно, другой пользователь уже провел распалубку.`
                    );
                }

                const trId = randomUUID();

                await client.query(`
                    INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, movement_date, transaction_id)
                    VALUES ($1, $2, 'wip_expense', 'Распалубка: Выход из сушилки', $3, $4, $5, COALESCE($6, NOW()), $7)
                `, [tileId, -totalRemoved, dryingWh, batchId, userId, movementDate || null, trId]);

                if (safeGood > 0) {
                    let remainingGood = safeGood;
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
                        const orderNeeds = Number(new Big(order.qty_production).round(2));
                        const allocate = Math.min(remainingGood, orderNeeds);
                        remainingGood -= allocate;

                        await client.query(`
                            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, linked_order_item_id, movement_date, transaction_id)
                            VALUES ($1, $2, 'reserve_receipt', $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9)
                        `, [tileId, allocate, `Распалубка: сразу в Резерв по ${order.doc_number}`, reserveWhId, batchId, userId, order.id, movementDate || null, trId]);

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
                            INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, movement_date, transaction_id)
                            VALUES ($1, $2, 'finished_receipt', 'Распалубка: 1-й сорт', $3, $4, $5, COALESCE($6, NOW()), $7)
                        `, [tileId, Number(new Big(remainingGood).round(2)), finishedWh, batchId, userId, movementDate || null, trId]);
                    }
                }

                if (grade2Qty > 0) {
                    const origItemRes = await client.query('SELECT name, article, category, unit, current_price, item_type, weight_kg, qty_per_cycle, amortization_per_cycle, mold_id, gost_mark, dealer_price FROM items WHERE id = $1', [tileId]);
                    let markdownTileId = tileId;

                    if (origItemRes.rows.length > 0) {
                        const orig = origItemRes.rows[0];
                        if (!orig.name.toLowerCase().includes('2 сорт') && !orig.name.toLowerCase().includes('2-й сорт')) {
                            const newName = `${orig.name.trim()} 2 сорт`;
                            const newArticle = orig.article ? `${orig.article.trim()}2S` : `${tileId}-2S`;
                            // ✅ FIX (п.6): Big.js для точного расчёта цены 2-го сорта
                            const newPrice = orig.current_price ? Number(new Big(orig.current_price).div(2).round(2)) : 0;
                            const newDealerPrice = orig.dealer_price ? Number(new Big(orig.dealer_price).div(2).round(2)) : 0;

                            const checkExistRes = await client.query('SELECT id FROM items WHERE name = $1 AND is_deleted = false LIMIT 1', [newName]);

                            if (checkExistRes.rows.length > 0) {
                                markdownTileId = checkExistRes.rows[0].id;
                            } else {
                                const insertRes = await client.query(`
                                    INSERT INTO items (name, article, category, unit, current_price, dealer_price, item_type, is_deleted, weight_kg, qty_per_cycle, amortization_per_cycle, mold_id, gost_mark)
                                    VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, $12)
                                    RETURNING id
                                `, [newName, newArticle, orig.category, orig.unit, newPrice, newDealerPrice, orig.item_type, orig.weight_kg, orig.qty_per_cycle, orig.amortization_per_cycle, orig.mold_id, orig.gost_mark]);
                                markdownTileId = insertRes.rows[0].id;
                            }
                        }
                    }

                    await client.query(`
                        INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, movement_date, transaction_id)
                        VALUES ($1, $2, 'markdown_receipt', 'Распалубка: 2-й сорт (Уценка)', $3, $4, $5, COALESCE($6, NOW()), $7)
                    `, [markdownTileId, safeGrade2, markdownWh, batchId, userId, movementDate || null, trId]);
                }

                if (scrapQty > 0) {
                    await client.query(`
                        INSERT INTO inventory_movements (item_id, quantity, movement_type, description, warehouse_id, batch_id, user_id, movement_date, transaction_id)
                        VALUES ($1, $2, 'scrap_receipt', 'Распалубка: Брак (Бой)', $3, $4, $5, COALESCE($6, NOW()), $7)
                    `, [tileId, safeScrap, defectWh, batchId, userId, movementDate || null, trId]);
                }

                // 🚀 НОВОЕ: Накапливаем 1-й сорт для сдельной зарплаты при каждой распалубке партии
                if (batchId && safeGood > 0) {
                    await client.query(`
                        UPDATE production_batches 
                        SET actual_good_qty = COALESCE(actual_good_qty, 0) + $1 
                        WHERE id = $2
                    `, [safeGood, batchId]);
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
            logger.error(err);
            const isBizError = err.message && (err.message.includes('Партия') || err.message.includes('Невозможно'));
            res.status(isBizError ? 400 : 500)
               .json({ error: isBizError ? err.message : 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 5. МАРШРУТ: БЕЗВОЗВРАТНАЯ УТИЛИЗАЦИЯ
    // ------------------------------------------------------------------
    router.post('/api/inventory/dispose', requireAdmin, validateScrap, async (req, res) => {
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
            logger.error(err);
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
            logger.error(err);
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

                // Находим account_id затронутых транзакций ДО удаления
                const affectedTxRes = await client.query(`SELECT DISTINCT account_id FROM transactions WHERE source_module = 'purchase' AND description LIKE $1 AND account_id IS NOT NULL`, [`%движение склада #${purchaseId})%`]);
                const affectedAccountIds = affectedTxRes.rows.map(r => r.account_id);

                await client.query(`DELETE FROM transactions WHERE source_module = 'purchase' AND description LIKE $1`, [`%движение склада #${purchaseId})%`]);
                await client.query(`DELETE FROM inventory_movements WHERE id = $1`, [purchaseId]);

                // 🔄 Пересчёт балансов затронутых касс после удаления
                if (affectedAccountIds.length > 0) {
                    await client.query(`
                        UPDATE accounts a
                        SET balance = ROUND(COALESCE((
                            SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE -amount END)
                            FROM transactions t WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                        ), 0), 2)
                        WHERE a.id = ANY($1::int[])
                    `, [affectedAccountIds]);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true, message: 'Закупка успешно отменена' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // СОХРАНЕНИЕ ИЗМЕНЕНИЙ ЗАКУПКИ (UPDATE + ПЕРЕСЧЕТ СРЕДНЕЙ ЦЕНЫ)
    // ------------------------------------------------------------------
    router.put('/api/inventory/purchase/:id', requireAdmin, validatePurchase, async (req, res) => {
        const purchaseId = req.params.id;
        const { itemId, counterparty_id, account_id, quantity, pricePerUnit, purchaseDate, totalCost: frontendTotal, deliveryCost, deliveryAccountId } = req.body;

        const qtyNum = Number(new Big(quantity || 0));
        const priceNum = Number(new Big(pricePerUnit || 0));
        const delCostNum = Number(new Big(deliveryCost || 0));
        // 🛡️ AUDIT-018: ad-hoc проверка удалена — покрыта validatePurchase middleware

        try {
            await withTransaction(pool, async (client) => {
                // --- ОПРЕДЕЛЯЕМ РЕАЛЬНЫЙ ТИП ТОВАРА ---
                const itemTypeRes = await client.query('SELECT item_type FROM items WHERE id = $1', [itemId]);
                const itemType = itemTypeRes.rows[0]?.item_type || 'material';
                const targetWh = await getWhId(client, itemType === 'product' ? 'finished' : 'materials');

                const materialCost = frontendTotal ? new Big(frontendTotal).toFixed(2) : new Big(qtyNum).times(priceNum).toFixed(2);
                const totalAmount = new Big(materialCost).plus(delCostNum).toFixed(2);
                const descMatch = `%движение склада #${purchaseId})%`;
                const typeName = itemType === 'product' ? 'продукции' : 'сырья';

                // --- МАГИЯ СРЕДНЕВЗВЕШЕННОЙ СТОИМОСТИ (ПЕРЕСЧЕТ) ---
                const oldMoveRes = await client.query(`SELECT quantity, amount FROM inventory_movements WHERE id = $1 AND movement_type = 'purchase'`, [purchaseId]);

                if (oldMoveRes.rows.length > 0) {
                    const oldQty = new Big(oldMoveRes.rows[0].quantity);
                    const oldAmount = new Big(oldMoveRes.rows[0].amount);

                    const stockRes = await client.query(`SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`, [itemId, targetWh]);
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
                        movement_date = COALESCE($6::timestamp, CURRENT_TIMESTAMP), 
                        description = $7, warehouse_id = $9
                    WHERE id = $8 AND movement_type = 'purchase'
                `, [itemId, counterparty_id, qtyNum, totalAmount, delCostNum, purchaseDate || null, `Закупка ${typeName} (ТМЦ: ${materialCost}, Дост: ${delCostNum})`, purchaseId, targetWh]);

                const oldMatTx = await client.query(`SELECT id FROM transactions WHERE source_module = 'purchase' AND description LIKE $1 AND category LIKE 'Закупка%'`, [descMatch]);
                if (account_id) {
                    if (oldMatTx.rows.length > 0) {
                        await client.query(`UPDATE transactions SET account_id = $1, amount = $2, transaction_date = COALESCE($3::timestamp, CURRENT_TIMESTAMP), category = $5, description = $6 WHERE id = $4`, [account_id, materialCost, purchaseDate || null, oldMatTx.rows[0].id, `Закупка ${typeName}`, `Оплата закупки (движение склада #${purchaseId})`]);
                    } else {
                        await client.query(`INSERT INTO transactions (account_id, amount, transaction_type, category, description, counterparty_id, payment_method, source_module, transaction_date, linked_purchase_id) VALUES ($1, $2, 'expense', $7, $3, $4, 'Безналичный расчет', 'purchase', COALESCE($5::timestamp, CURRENT_TIMESTAMP), $6)`, [account_id, materialCost, `Оплата закупки (движение склада #${purchaseId})`, counterparty_id, purchaseDate || null, purchaseId, `Закупка ${typeName}`]);
                    }
                } else if (oldMatTx.rows.length > 0) {
                    await client.query(`DELETE FROM transactions WHERE id = $1`, [oldMatTx.rows[0].id]);
                }

                const oldDelTx = await client.query(`SELECT id FROM transactions WHERE source_module = 'purchase' AND description LIKE $1 AND category = 'Транспортные расходы'`, [descMatch]);
                if (delCostNum > 0 && deliveryAccountId) {
                    if (oldDelTx.rows.length > 0) {
                        await client.query(`UPDATE transactions SET account_id = $1, amount = $2, transaction_date = COALESCE($3::timestamp, CURRENT_TIMESTAMP) WHERE id = $4`, [deliveryAccountId, delCostNum, purchaseDate || null, oldDelTx.rows[0].id]);
                    } else {
                        await client.query(`INSERT INTO transactions (account_id, amount, transaction_type, category, description, counterparty_id, payment_method, source_module, transaction_date, linked_purchase_id) VALUES ($1, $2, 'expense', 'Транспортные расходы', $3, $4, 'Безналичный расчет', 'purchase', COALESCE($5::timestamp, CURRENT_TIMESTAMP), $6)`, [deliveryAccountId, delCostNum, `Оплата доставки (движение склада #${purchaseId})`, counterparty_id, purchaseDate || null, purchaseId]);
                    }
                } else if (oldDelTx.rows.length > 0) {
                    await client.query(`DELETE FROM transactions WHERE id = $1`, [oldDelTx.rows[0].id]);
                }

                // 🔄 Пересчёт балансов всех затронутых касс
                const affectedAccounts = [account_id, deliveryAccountId].filter(Boolean);
                if (affectedAccounts.length > 0) {
                    await client.query(`
                        UPDATE accounts a
                        SET balance = ROUND(COALESCE((
                            SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE -amount END)
                            FROM transactions t WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                        ), 0), 2)
                        WHERE a.id = ANY($1::int[])
                    `, [affectedAccounts]);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true, message: 'Закупка обновлена' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });

    // ------------------------------------------------------------------
    // СОЗДАНИЕ НОВОЙ ЗАКУПКИ (POST + РАСЧЕТ СРЕДНЕЙ ЦЕНЫ)
    // ------------------------------------------------------------------
    router.post('/api/inventory/purchase', requireAdmin, validatePurchase, async (req, res) => {
        const { itemId, quantity, pricePerUnit, counterparty_id, account_id, purchaseDate, totalCost: frontendTotal, deliveryCost, deliveryAccountId } = req.body;
        // 🛡️ AUDIT-018: ad-hoc проверки itemId, counterparty_id, qtyNum удалены — покрыты validatePurchase middleware
        const qtyNum = Number(new Big(quantity || 0));
        const priceNum = Number(new Big(pricePerUnit || 0));
        const delCostNum = Number(new Big(deliveryCost || 0));

        try {
            await withTransaction(pool, async (client) => {
                // --- ОПРЕДЕЛЯЕМ РЕАЛЬНЫЙ ТИП ТОВАРА ---
                const itemTypeRes = await client.query('SELECT item_type FROM items WHERE id = $1', [itemId]);
                const itemType = itemTypeRes.rows[0]?.item_type || 'material';
                const targetWh = await getWhId(client, itemType === 'product' ? 'finished' : 'materials');
                const typeName = itemType === 'product' ? 'продукции' : 'сырья';

                const materialCost = frontendTotal ? new Big(frontendTotal).toFixed(2) : new Big(qtyNum).times(priceNum).toFixed(2);
                const totalAmount = new Big(materialCost).plus(delCostNum).toFixed(2);

                // --- МАГИЯ СРЕДНЕВЗВЕШЕННОЙ СТОИМОСТИ (POST) ---
                const stockRes = await client.query(`SELECT COALESCE(SUM(quantity), 0) as balance FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`, [itemId, targetWh]);
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
                `, [itemId, qtyNum, targetWh, counterparty_id, totalAmount, delCostNum, `Закупка ${typeName} (ТМЦ: ${materialCost}, Дост: ${delCostNum})`, purchaseDate || null]);

                if (account_id) {
                    await client.query(`INSERT INTO transactions (account_id, amount, transaction_type, category, description, counterparty_id, payment_method, source_module, transaction_date, linked_purchase_id) VALUES ($1, $2, 'expense', $7, $3, $4, 'Безналичный расчет', 'purchase', COALESCE($5::timestamp, CURRENT_TIMESTAMP), $6)`, [account_id, materialCost, `Оплата закупки (движение склада #${moveRes.rows[0].id})`, counterparty_id, purchaseDate || null, moveRes.rows[0].id, `Закупка ${typeName}`]);
                }
                if (delCostNum > 0 && deliveryAccountId) {
                    await client.query(`INSERT INTO transactions (account_id, amount, transaction_type, category, description, counterparty_id, payment_method, source_module, transaction_date, linked_purchase_id) VALUES ($1, $2, 'expense', 'Транспортные расходы', $3, $4, 'Безналичный расчет', 'purchase', COALESCE($5::timestamp, CURRENT_TIMESTAMP), $6)`, [deliveryAccountId, delCostNum, `Оплата доставки (движение склада #${moveRes.rows[0].id})`, counterparty_id, purchaseDate || null, moveRes.rows[0].id]);
                }

                // 🔄 Пересчёт балансов всех затронутых касс
                const affectedAccounts = [account_id, deliveryAccountId].filter(Boolean);
                if (affectedAccounts.length > 0) {
                    await client.query(`
                        UPDATE accounts a
                        SET balance = ROUND(COALESCE((
                            SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE -amount END)
                            FROM transactions t WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
                        ), 0), 2)
                        WHERE a.id = ANY($1::int[])
                    `, [affectedAccounts]);
                }
            });

            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            res.json({ success: true });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        }
    });




    // ------------------------------------------------------------------
    // ПОЛУЧЕНИЕ ДЕТАЛЕЙ ЗАКУПКИ (ДЛЯ РЕДАКТИРОВАНИЯ)
    // ------------------------------------------------------------------
    router.get('/api/inventory/purchase/:id', async (req, res) => {
        try {
            const purchaseId = req.params.id;

            const moveRes = await pool.query(`
                SELECT item_id, supplier_id, quantity, amount, COALESCE(delivery_cost, 0) as delivery_cost, to_char(movement_date, 'YYYY-MM-DD') as purchase_date
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
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
                    to_char(im.movement_date, 'YYYY-MM-DD') as purchase_date
                FROM inventory_movements im
                JOIN items i ON im.item_id = i.id
                LEFT JOIN counterparties c ON im.supplier_id = c.id
                WHERE im.movement_type = 'purchase'
                  AND (i.name ILIKE $1 OR c.name ILIKE $1 OR c.inn ILIKE $1)
                ORDER BY im.movement_date DESC
                LIMIT 50
            `;
            const result = await pool.query(query, [searchPattern]);
            res.json(result.rows);
        } catch (err) {
            logger.error(err);
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
                ORDER BY production_date DESC LIMIT 10
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
            logger.error(err);
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
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Внутренняя ошибка сервера. Обратитесь к администратору.' });
        }
    });

    // ------------------------------------------------------------------
    // 8. УПРАВЛЕНИЕ РЕЗЕРВАМИ: Снятие / Переброска
    // ------------------------------------------------------------------
    router.post('/api/inventory/reserve-action', requireAdmin, validateReserveAction, async (req, res) => {
        const { action, itemId, batchId, linkedOrderItemId, qty, targetOrderItemId } = req.body;
        // 🛡️ AUDIT-018: ad-hoc проверка удалена — покрыта validateReserveAction middleware

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
            logger.error(err);
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
            logger.error(err);
            res.status(500).json({ error: 'Ошибка получения заказов.' });
        }
    });
    // ------------------------------------------------------------------
    // РЕДАКТИРОВАНИЕ ДВИЖЕНИЯ (PUT /api/inventory/movement/:id)
    // ------------------------------------------------------------------
    router.put('/api/inventory/movement/:id', requireAdmin, async (req, res) => {
        const movementId = req.params.id;
        const { movement_date, description } = req.body;
        
        try {
            await withTransaction(pool, async (client) => {
                const movRes = await client.query('SELECT transaction_id, batch_id, movement_date FROM inventory_movements WHERE id = $1', [movementId]);
                if (movRes.rows.length === 0) throw new Error('Запись не найдена');
                
                const { transaction_id, batch_id, movement_date: old_date } = movRes.rows[0];
                
                if (transaction_id) {
                    await client.query(`
                        UPDATE inventory_movements
                        SET movement_date = $1
                        WHERE transaction_id = $2
                    `, [movement_date, transaction_id]);
                    await client.query(`
                        UPDATE inventory_movements
                        SET description = $1
                        WHERE id = $2
                    `, [description, movementId]);
                } else if (batch_id) {
                    await client.query(`
                        UPDATE inventory_movements
                        SET movement_date = $1
                        WHERE batch_id = $2 AND movement_date::timestamp(0) = $3::timestamp(0)
                    `, [movement_date, batch_id, old_date]);
                    await client.query(`
                        UPDATE inventory_movements
                        SET description = $1
                        WHERE id = $2
                    `, [description, movementId]);
                } else {
                    await client.query(`
                        UPDATE inventory_movements
                        SET movement_date = $1, description = $2
                        WHERE id = $3
                    `, [movement_date, description, movementId]);
                }
            });
            
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            
            res.json({ success: true, message: 'Запись успешно обновлена' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: 'Ошибка обновления движения.' });
        }
    });

    // ------------------------------------------------------------------
    // УДАЛЕНИЕ ДВИЖЕНИЯ И ОТКАТ (DELETE /api/inventory/movement/:id)
    // ------------------------------------------------------------------
    router.delete('/api/inventory/movement/:id', requireAdmin, async (req, res) => {
        const movementId = req.params.id;
        
        try {
            await withTransaction(pool, async (client) => {
                const movRes = await client.query('SELECT transaction_id, batch_id, movement_date FROM inventory_movements WHERE id = $1', [movementId]);
                if (movRes.rows.length === 0) throw new Error('Запись не найдена');
                
                const { transaction_id, batch_id, movement_date } = movRes.rows[0];
                
                let targetMovementsRes;
                if (transaction_id) {
                    // Safe grouping by transaction ID
                    targetMovementsRes = await client.query('SELECT * FROM inventory_movements WHERE transaction_id = $1', [transaction_id]);
                } else if (batch_id) {
                    // Fallback for older transactions without UUID. We drop to timestamp(0) to ignore JS microsecond precision loss!
                    targetMovementsRes = await client.query('SELECT * FROM inventory_movements WHERE batch_id = $1 AND movement_date::timestamp(0) = $2::timestamp(0)', [batch_id, movement_date]);
                } else {
                    targetMovementsRes = await client.query('SELECT * FROM inventory_movements WHERE id = $1', [movementId]);
                }

                const movements = targetMovementsRes.rows;

                for (const mov of movements) {
                    // 1. Rollback Reserves
                    if (mov.movement_type === 'reserve_receipt' && mov.linked_order_item_id) {
                        const reserveQty = parseFloat(mov.quantity);
                        await client.query(`
                            UPDATE client_order_items 
                            SET qty_reserved = GREATEST(COALESCE(qty_reserved, 0) - $1, 0),
                                qty_production = COALESCE(qty_production, 0) + $1
                            WHERE id = $2
                        `, [reserveQty, mov.linked_order_item_id]);

                        const ppCheck = await client.query('SELECT id FROM planned_production WHERE order_item_id = $1 LIMIT 1', [mov.linked_order_item_id]);
                        if (ppCheck.rows.length > 0) {
                            await client.query('UPDATE planned_production SET quantity = COALESCE(quantity, 0) + $1 WHERE id = $2', [reserveQty, ppCheck.rows[0].id]);
                        } else {
                            await client.query('INSERT INTO planned_production (order_item_id, quantity) VALUES ($1, $2)', [mov.linked_order_item_id, reserveQty]);
                        }
                    }

                    // 2. Rollback Production Batch Yield (Payroll fix)
                    if (mov.movement_type === 'finished_receipt' && mov.batch_id) {
                        await client.query(`
                            UPDATE production_batches 
                            SET actual_good_qty = GREATEST(COALESCE(actual_good_qty, 0) - $1, 0)
                            WHERE id = $2
                        `, [parseFloat(mov.quantity), mov.batch_id]);
                        
                        // We also revert status from completed if we deleted the demolding
                        await client.query(`UPDATE production_batches SET status = 'in_drying' WHERE id = $1`, [mov.batch_id]);
                    }
                }

                // Execute safe exact deletion by IDs
                const idsToDelete = movements.map(m => m.id);
                if (idsToDelete.length > 0) {
                    await client.query('DELETE FROM inventory_movements WHERE id = ANY($1)', [idsToDelete]);
                }
            });
            
            const io = req.app.get('io');
            if (io) io.emit('inventory_updated');
            
            res.json({ success: true, message: 'Записи успешно удалены' });
        } catch (err) {
            logger.error(err);
            res.status(500).json({ error: err.message || 'Ошибка удаления.' });
        }
    });

    return router;
};