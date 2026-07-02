/**
 * Интеграционные тесты: Производство (routes/production.js)
 * Стратегия: Mock-pool (без реальной БД), обход JWT через мок-middleware.
 */
const request = require('supertest');
const { createMockPool, createMockWithTransaction, createTestApp } = require('../helpers/testApp');

describe('Production API', () => {
    let app, mockPool, mockWithTransaction, io;
    const mockGetWhId = jest.fn().mockResolvedValue(1);

    beforeEach(() => {
        jest.resetModules();
        mockPool = createMockPool();
        mockWithTransaction = createMockWithTransaction(mockPool);

        const prodRouteFactory = require('../../routes/production');
        const result = createTestApp(prodRouteFactory, [mockPool, mockGetWhId, mockWithTransaction]);
        app = result.app;
        io = result.io;
    });

    // =========================================================
    // 1. GET /api/production/history — История формовок
    // =========================================================
    describe('GET /api/production/history', () => {
        test('✅ Получение истории — успех (200)', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('production_batches') || text.includes('history')) {
                    return { rows: [
                        { id: 1, production_date: '2026-06-15', product_name: 'Плитка 400x400', planned_qty: 500, actual_good_qty: 480, status: 'completed' }
                    ] };
                }
                return { rows: [] };
            });

            const res = await request(app)
                .get('/api/production/history')
                .query({ date: '2026-06-15' });
            expect(res.status).toBe(200);
        });
    });

    // =========================================================
    // 2. GET /api/production/mrp-summary — MRP
    // =========================================================
    describe('GET /api/production/mrp-summary', () => {
        test('✅ MRP summary — возвращает данные', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app).get('/api/production/mrp-summary');
            expect(res.status).toBe(200);
        });
    });

    // =========================================================
    // 3. GET /api/production/active-dates — Активные даты
    // =========================================================
    describe('GET /api/production/active-dates', () => {
        test('✅ Получение активных дат — успех', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app).get('/api/production/active-dates');
            expect(res.status).toBe(200);
        });
    });

    // =========================================================
    // 4. GET /api/production/in-drying — В сушке
    // =========================================================
    describe('GET /api/production/in-drying', () => {
        test('✅ Получение партий в сушке — успех', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app).get('/api/production/in-drying');
            expect(res.status).toBe(200);
        });
    });

    // =========================================================
    // 5. GET /api/mix-templates — Шаблоны замесов
    // =========================================================
    describe('GET /api/mix-templates', () => {
        test('✅ Получение шаблонов — успех', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app).get('/api/mix-templates');
            expect(res.status).toBe(200);
        });
    });
});
