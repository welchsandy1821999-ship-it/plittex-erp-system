/**
 * Интеграционные тесты: Склад и Инвентаризация (routes/inventory.js)
 * Стратегия: Mock-pool (без реальной БД), обход JWT через мок-middleware.
 */
const request = require('supertest');
const { createMockPool, createMockWithTransaction, createTestApp } = require('../helpers/testApp');

describe('Inventory API', () => {
    let app, mockPool, mockWithTransaction, io;
    const mockGetWhId = jest.fn().mockResolvedValue(1);

    beforeEach(() => {
        jest.resetModules();
        mockPool = createMockPool();
        mockWithTransaction = createMockWithTransaction(mockPool);

        const inventoryRouteFactory = require('../../routes/inventory');
        const result = createTestApp(inventoryRouteFactory, [mockPool, mockGetWhId, mockWithTransaction]);
        app = result.app;
        io = result.io;
    });

    // =========================================================
    // 1. GET /api/inventory — Список остатков
    // =========================================================
    describe('GET /api/inventory', () => {
        test('✅ Получение остатков — успех (200)', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('inventory') || text.includes('SUM')) {
                    return { rows: [
                        { product_id: 1, product_name: 'Тротуарная плитка 400x400', warehouse_id: 2, quantity: '150', unit: 'шт' }
                    ] };
                }
                return { rows: [] };
            });

            const res = await request(app).get('/api/inventory');
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });
    });

    // =========================================================
    // 2. GET /api/inventory/valuation — Оценка склада
    // =========================================================
    describe('GET /api/inventory/valuation', () => {
        test('✅ Оценка склада — возвращает данные', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app).get('/api/inventory/valuation');
            expect(res.status).toBe(200);
        });
    });

    // =========================================================
    // 3. GET /api/inventory/drying-dates — Даты сушки
    // =========================================================
    describe('GET /api/inventory/drying-dates', () => {
        test('✅ Получение дат сушки — успех', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app).get('/api/inventory/drying-dates');
            expect(res.status).toBe(200);
        });
    });

    // =========================================================
    // 4. GET /api/inventory/purchase-dates — Даты закупок
    // =========================================================
    describe('GET /api/inventory/purchase-dates', () => {
        test('✅ Получение дат закупок — успех', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app).get('/api/inventory/purchase-dates');
            expect(res.status).toBe(200);
        });
    });

    // =========================================================
    // 5. GET /api/inventory/daily-purchases — Дневные закупки
    // =========================================================
    describe('GET /api/inventory/daily-purchases', () => {
        test('✅ Получение дневных закупок — успех', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app)
                .get('/api/inventory/daily-purchases')
                .query({ date: '2026-06-15' });
            expect(res.status).toBe(200);
        });
    });
});
