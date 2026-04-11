/**
 * Интеграционные тесты: Финансовый модуль (routes/finance.js)
 * Стратегия: Mock-pool (без реальной БД), обход JWT через мок-middleware.
 */
const request = require('supertest');
const { createMockPool, createMockWithTransaction, createTestApp } = require('../helpers/testApp');

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const ERP_CONFIG = { vatRate: 20, vatRatio: 122, noVatCategories: ['Зарплата'] };

describe('Finance API', () => {
    let app, mockPool, mockWithTransaction, io;

    beforeEach(() => {
        jest.resetModules();
        mockPool = createMockPool({
            'UPDATE accounts': { rows: [], rowCount: 1 },
            'INSERT INTO transactions': { rows: [{ id: 99 }], rowCount: 1 },
            'DELETE FROM transaction_rules': { rows: [], rowCount: 0 },
            'lock_date': { rows: [] }
        });
        mockWithTransaction = createMockWithTransaction(mockPool);

        const financeRouteFactory = require('../../routes/finance');
        const result = createTestApp(financeRouteFactory, [mockPool, upload, mockWithTransaction, ERP_CONFIG]);
        app = result.app;
        io = result.io;
    });

    // =========================================================
    // 1. POST /api/transactions — Создание транзакции
    // =========================================================
    describe('POST /api/transactions', () => {
        const validTransaction = {
            amount: 15000,
            type: 'income',
            category: 'Оплата заказа',
            description: 'Тестовый приход',
            method: 'cash',
            account_id: 1
        };

        test('✅ Создание транзакции — успех (200)', async () => {
            const res = await request(app)
                .post('/api/transactions')
                .send(validTransaction);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toBe('Операция сохранена');
        });

        test('✅ WebSocket: emit finance_updated после создания', async () => {
            await request(app)
                .post('/api/transactions')
                .send(validTransaction);

            expect(io.emit).toHaveBeenCalledWith('finance_updated');
        });

        test('❌ Валидация: сумма <= 0 — отклонена (400)', async () => {
            const res = await request(app)
                .post('/api/transactions')
                .send({ ...validTransaction, amount: -100 });
            expect(res.status).toBe(400);
        });

        test('❌ Валидация: отсутствует account_id — отклонена (400)', async () => {
            const res = await request(app)
                .post('/api/transactions')
                .send({ ...validTransaction, account_id: undefined });
            expect(res.status).toBe(400);
        });

        test('❌ Валидация: неверный тип транзакции — отклонена (400)', async () => {
            const res = await request(app)
                .post('/api/transactions')
                .send({ ...validTransaction, type: 'invalid_type' });
            expect(res.status).toBe(400);
        });
    });

    // =========================================================
    // 2. POST /api/transactions/transfer — Перевод между счетами
    // =========================================================
    describe('POST /api/transactions/transfer', () => {
        const validTransfer = {
            amount: 5000,
            from_account_id: 1,
            to_account_id: 2,
            description: 'Перевод касса → расчетный'
        };

        test('✅ Перевод между счетами — успех (200)', async () => {
            const res = await request(app)
                .post('/api/transactions/transfer')
                .send(validTransfer);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toBe('Перевод выполнен');
        });

        test('✅ WebSocket: emit finance_updated после перевода', async () => {
            await request(app)
                .post('/api/transactions/transfer')
                .send(validTransfer);
            expect(io.emit).toHaveBeenCalledWith('finance_updated');
        });

        test('❌ Валидация: перевод без суммы — отклонён (400)', async () => {
            const res = await request(app)
                .post('/api/transactions/transfer')
                .send({ ...validTransfer, amount: 0 });
            expect(res.status).toBe(400);
        });

        test('❌ Валидация: перевод без from_account_id — отклонён (400)', async () => {
            const res = await request(app)
                .post('/api/transactions/transfer')
                .send({ ...validTransfer, from_account_id: undefined });
            expect(res.status).toBe(400);
        });
    });

    // =========================================================
    // 3. DELETE /api/transactions/:id — Удаление транзакции
    // =========================================================
    describe('DELETE /api/transactions/:id', () => {
        test('✅ Удаление транзакции — успех (200)', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('source_module')) {
                    return { rows: [{
                        description: 'Тест', source_module: null, linked_id: null,
                        amount: 100, transaction_type: 'income',
                        linked_order_id: null, linked_planned_id: null, linked_purchase_id: null
                    }] };
                }
                return { rows: [], rowCount: 1 };
            });

            const res = await request(app).delete('/api/transactions/1');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        test('❌ Удаление несуществующей транзакции — ошибка', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('source_module')) {
                    return { rows: [] };
                }
                return { rows: [] };
            });

            const res = await request(app).delete('/api/transactions/999');
            expect(res.status).toBe(500);
        });
    });
});
