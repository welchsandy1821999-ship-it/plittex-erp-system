/**
 * Интеграционные тесты: Продажи (routes/sales.js)
 * Стратегия: Mock-pool (без реальной БД), обход JWT через мок-middleware.
 */
const request = require('supertest');
const { createMockPool, createMockWithTransaction, createTestApp } = require('../helpers/testApp');

const ERP_CONFIG = { vatRate: 20, vatRatio: 122, noVatCategories: ['Зарплата'] };

describe('Sales API', () => {
    let app, mockPool, mockWithTransaction, io;
    const mockGetWhId = jest.fn().mockResolvedValue(1);
    const mockGetNextDocNumber = jest.fn().mockResolvedValue('ЗК-00100');

    beforeEach(() => {
        jest.resetModules();
        mockPool = createMockPool();
        mockWithTransaction = createMockWithTransaction(mockPool);

        const salesRouteFactory = require('../../routes/sales');
        const result = createTestApp(salesRouteFactory, [mockPool, mockGetWhId, mockGetNextDocNumber, mockWithTransaction, ERP_CONFIG]);
        app = result.app;
        io = result.io;
    });

    // =========================================================
    // 1. GET /api/sales/orders — Список заказов
    // =========================================================
    describe('GET /api/sales/orders', () => {
        test('✅ Получение заказов — успех (200)', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('client_orders') || text.includes('orders')) {
                    return { rows: [
                        { id: 1, order_number: 'ЗК-00099', status: 'active', counterparty_id: 5, total_amount: '150000' }
                    ] };
                }
                return { rows: [] };
            });

            const res = await request(app).get('/api/sales/orders');
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });
    });

    // =========================================================
    // 2. GET /api/sales/history — История продаж
    // =========================================================
    describe('GET /api/sales/history', () => {
        test('✅ Получение истории продаж — успех (200)', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app).get('/api/sales/history');
            expect(res.status).toBe(200);
        });
    });

    // =========================================================
    // 3. GET /api/sales/shipment-dashboard — Панель отгрузок
    // =========================================================
    describe('GET /api/sales/shipment-dashboard', () => {
        test('✅ Панель отгрузок — успех (200)', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app).get('/api/sales/shipment-dashboard');
            expect(res.status).toBe(200);
        });
    });

    // =========================================================
    // 4. GET /api/blank-orders — Черновики заказов
    // =========================================================
    describe('GET /api/blank-orders', () => {
        test('✅ Получение черновиков — успех (200)', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });
            const res = await request(app).get('/api/blank-orders');
            expect(res.status).toBe(200);
        });
    });
});
