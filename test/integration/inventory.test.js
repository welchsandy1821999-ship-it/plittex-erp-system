/**
 * Интеграционные тесты: Модуль Склада — Распалубка (POST /api/move-wip)
 * Проверяем: жёсткое обнуление, защиту от перерасхода, Big.js округление, WebSocket.
 */
const request = require('supertest');
const { createMockPool, createMockWithTransaction, createTestApp } = require('../helpers/testApp');

describe('Inventory API — Распалубка (move-wip)', () => {
    let app, mockPool, mockWithTransaction, io;

    const mockGetWhId = jest.fn(async (client, type) => {
        const map = { drying: 1, finished: 2, markdown: 3, defect: 4, reserve: 5 };
        if (map[type]) return map[type];
        throw new Error(`Склад '${type}' не найден!`);
    });

    /** Стандартный обработчик запросов для move-wip */
    function setupDefaultMock(pool, overrides = {}) {
        const insertLog = [];
        pool._queryFn.mockImplementation(async (text, params) => {
            if (text.includes('SELECT id FROM users')) return { rows: [{ id: 1 }] };
            if (text.includes('FOR UPDATE')) return { rows: [{ id: params?.[0] || 1 }] };
            if (text.includes('real_balance')) return overrides.balance || { rows: [{ real_balance: '100.00' }] };
            if (text.includes('cost_per_unit')) return { rows: [{ cost_per_unit: '10.00' }] };
            if (text.includes('qty_production')) return { rows: [] };
            if (text.includes('INSERT') || text.includes('UPDATE')) {
                insertLog.push({ text, params });
                return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        return insertLog;
    }

    beforeEach(() => {
        jest.resetModules(); // Очищаем кеш модулей
        mockGetWhId.mockClear();
        mockPool = createMockPool();
        mockWithTransaction = createMockWithTransaction(mockPool);

        const inventoryRouteFactory = require('../../routes/inventory');
        const result = createTestApp(inventoryRouteFactory, [mockPool, mockGetWhId, mockWithTransaction]);
        app = result.app;
        io = result.io;

        // Default mock
        setupDefaultMock(mockPool);
    });

    // =========================================================
    // 1. Частичная распалубка — успех
    // =========================================================
    test('✅ Частичная распалубка — успех (200)', async () => {
        const res = await request(app)
            .post('/api/move-wip')
            .send({
                batchId: 1, tileId: 10, currentWipQty: 100,
                goodQty: 50, grade2Qty: 5, scrapQty: 3, isComplete: false
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    // =========================================================
    // 2. Жёсткое обнуление (isComplete: true)
    // =========================================================
    test('✅ isComplete=true — жёсткое обнуление, списывает весь остаток', async () => {
        const insertLog = setupDefaultMock(mockPool);

        const res = await request(app)
            .post('/api/move-wip')
            .send({
                batchId: 1, tileId: 10, currentWipQty: 100,
                goodQty: 80, grade2Qty: 0, scrapQty: 0, isComplete: true
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const wipExpense = insertLog.find(q => q.text.includes('wip_expense'));
        expect(wipExpense).toBeDefined();
        // При isComplete totalRemoved = realWipBalance = 100
        expect(wipExpense.params[1]).toBe(-100);
    });

    // =========================================================
    // 3. WebSocket emit после распалубки
    // =========================================================
    test('✅ WebSocket: emit inventory_updated после распалубки', async () => {
        await request(app)
            .post('/api/move-wip')
            .send({
                batchId: 1, tileId: 10, currentWipQty: 100,
                goodQty: 10, grade2Qty: 0, scrapQty: 0, isComplete: false
            });

        expect(io.emit).toHaveBeenCalledWith('inventory_updated');
    });

    // =========================================================
    // 4. Защита от перерасхода
    // =========================================================
    test('❌ Перерасход при частичной распалубке — отклонён (400)', async () => {
        const res = await request(app)
            .post('/api/move-wip')
            .send({
                batchId: 1, tileId: 10, currentWipQty: 100,
                goodQty: 90, grade2Qty: 20, scrapQty: 5, // 115 > 100
                isComplete: false
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Невозможно списать');
    });

    // =========================================================
    // 5. Защита от двойного клика (остаток = 0)
    // =========================================================
    test('❌ Двойной клик — партия уже пуста (400)', async () => {
        setupDefaultMock(mockPool, { balance: { rows: [{ real_balance: '0' }] } });

        const res = await request(app)
            .post('/api/move-wip')
            .send({
                batchId: 1, tileId: 10, currentWipQty: 0,
                goodQty: 50, grade2Qty: 0, scrapQty: 0, isComplete: false
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('уже полностью распалублена');
    });

    // =========================================================
    // 6. Big.js: Округление до 2 знаков
    // =========================================================
    test('✅ Big.js: дробные значения округляются до 2 знаков', async () => {
        const insertLog = setupDefaultMock(mockPool);

        const res = await request(app)
            .post('/api/move-wip')
            .send({
                batchId: 1, tileId: 10, currentWipQty: 100,
                goodQty: 33.337, grade2Qty: 11.114, scrapQty: 5.559,
                isComplete: false
            });

        expect(res.status).toBe(200);

        // round(33.337,2)=33.34, round(11.114,2)=11.11, round(5.559,2)=5.56
        // reportedQty = 33.34 + 11.11 + 5.56 = 50.01
        const wipExpense = insertLog.find(q => q.text.includes('wip_expense'));
        expect(wipExpense).toBeDefined();
        const removedQty = Math.abs(wipExpense.params[1]);
        expect(removedQty).toBeCloseTo(50.01, 2);
    });
});
