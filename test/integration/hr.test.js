/**
 * Интеграционные тесты: Кадры и Зарплата (routes/hr.js)
 * Стратегия: Mock-pool (без реальной БД), обход JWT через мок-middleware.
 */
const request = require('supertest');
const { createMockPool, createMockWithTransaction, createTestApp } = require('../helpers/testApp');

describe('HR & Salary API', () => {
    let app, mockPool, mockWithTransaction, io;

    beforeEach(() => {
        jest.resetModules();
        mockPool = createMockPool({
            'closed_periods': { rows: [] },
            'INSERT INTO salary_adjustments': { rows: [{ id: 1 }], rowCount: 1 },
            'INSERT INTO transactions': { rows: [{ id: 1 }], rowCount: 1 },
            'UPDATE salary_adjustments': { rows: [], rowCount: 1 },
            'counterparties': { rows: [{ id: 10 }] },
            'accounts': { rows: [{ id: 5, balance: '50000', name: 'Касса', type: 'cash' }] },
            'information_schema.columns': { rows: [{ column_name: 'category' }] }
        });
        mockWithTransaction = createMockWithTransaction(mockPool);

        const hrRouteFactory = require('../../routes/hr');
        const result = createTestApp(hrRouteFactory, [mockPool, mockWithTransaction]);
        app = result.app;
        io = result.io;
    });

    // =========================================================
    // 1. GET /api/timesheet/month — Получение табеля за месяц
    // =========================================================
    describe('GET /api/timesheet/month', () => {
        test('✅ Получение табеля — успех (200)', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('timesheet_records')) {
                    return { rows: [
                        { employee_id: 1, record_date: '2026-06-01', status: 'present', bonus: '0', penalty: '0' },
                        { employee_id: 1, record_date: '2026-06-02', status: 'weekend', bonus: '0', penalty: '0' }
                    ] };
                }
                return { rows: [] };
            });

            const res = await request(app)
                .get('/api/timesheet/month')
                .query({ year: '2026', month: '06' });

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            expect(res.body.length).toBe(2);
            expect(res.body[0].status).toBe('present');
        });
    });

    // =========================================================
    // 2. POST /api/timesheet/cell — Сохранение ячейки табеля
    // =========================================================
    describe('POST /api/timesheet/cell', () => {
        const validCell = {
            employee_id: 1,
            date: '2026-06-15',
            status: 'present',
            bonus: 500,
            penalty: 0,
            bonus_comment: 'Хорошая работа',
            penalty_comment: '',
            multiplier: 1.0
        };

        test('✅ Сохранение ячейки табеля — успех (200)', async () => {
            const res = await request(app)
                .post('/api/timesheet/cell')
                .send(validCell);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        test('❌ Запись в закрытый месяц — отклонена (403)', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('closed_periods')) {
                    return { rows: [{ period_str: '2026-06', module: 'salary' }] };
                }
                return { rows: [] };
            });

            const res = await request(app)
                .post('/api/timesheet/cell')
                .send(validCell);
            expect(res.status).toBe(403);
        });

        test('❌ Невалидный статус — отклонён (400)', async () => {
            const res = await request(app)
                .post('/api/timesheet/cell')
                .send({ ...validCell, status: 'hacked_status' });
            expect(res.status).toBe(400);
        });
    });

    // =========================================================
    // 3. POST /api/salary/pay — Выплата зарплаты
    // =========================================================
    describe('POST /api/salary/pay', () => {
        const validPayment = {
            employee_id: 1,
            amount: 25000,
            date: '2026-06-15',
            description: 'Аванс за июнь',
            account_id: 5
        };

        test('✅ Выплата зарплаты — успех (200)', async () => {
            mockPool._queryFn.mockImplementation(async (text, params) => {
                if (text.includes('closed_periods')) return { rows: [] };
                if (text.includes('SELECT balance')) return { rows: [{ balance: '50000', name: 'Касса', type: 'cash' }] };
                if (text.includes('counterparties')) return { rows: [{ id: 10 }] };
                if (text.includes('accounts') && text.includes('imprest')) return { rows: [{ id: 20 }] };
                if (text.includes('INSERT INTO transactions')) return { rows: [{ id: 99 }] };
                if (text.includes('INSERT INTO salary_payments')) return { rows: [{ id: 1 }] };
                return { rows: [], rowCount: 1 };
            });

            const res = await request(app)
                .post('/api/salary/pay')
                .send(validPayment);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        test('❌ Выплата в закрытый месяц — отклонена (403)', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('closed_periods')) {
                    return { rows: [{ period_str: '2026-06' }] };
                }
                return { rows: [] };
            });

            const res = await request(app)
                .post('/api/salary/pay')
                .send(validPayment);
            expect(res.status).toBe(403);
        });

        test('❌ Отрицательная сумма — отклонена (400)', async () => {
            const res = await request(app)
                .post('/api/salary/pay')
                .send({ ...validPayment, amount: -5000 });
            expect(res.status).toBe(400);
        });
    });

    // =========================================================
    // 4. POST /api/salary/adjustments — Корректировки (ГСМ, займы)
    // =========================================================
    describe('POST /api/salary/adjustments', () => {
        const validAdjustment = {
            employee_id: 1,
            month_str: '2026-06',
            amount: -3000,
            category: 'ГСМ',
            description: 'Заправка служебного авто',
            cash_posting_mode: 'none'
        };

        test('✅ Создание корректировки — успех (200)', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('closed_periods')) return { rows: [] };
                if (text.includes('counterparties')) return { rows: [{ id: 10 }] };
                if (text.includes('information_schema')) return { rows: [{ column_name: 'category' }] };
                if (text.includes('INSERT INTO salary_adjustments')) return { rows: [{ id: 1 }] };
                if (text.includes('INSERT INTO transactions')) return { rows: [{ id: 99 }] };
                if (text.includes('accounts')) return { rows: [{ id: 5, type: 'cash' }] };
                return { rows: [], rowCount: 1 };
            });

            const res = await request(app)
                .post('/api/salary/adjustments')
                .send({ ...validAdjustment, amount: 500 });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        test('❌ Корректировка в закрытый месяц — отклонена (403)', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('closed_periods')) {
                    return { rows: [{ period_str: '2026-06' }] };
                }
                return { rows: [] };
            });

            const res = await request(app)
                .post('/api/salary/adjustments')
                .send(validAdjustment);
            expect(res.status).toBe(403);
        });
    });

    // =========================================================
    // 5. GET /api/salary/is-closed — Статус закрытия месяца
    // =========================================================
    describe('GET /api/salary/is-closed', () => {
        test('✅ Открытый месяц — isClosed: false', async () => {
            mockPool._queryFn.mockResolvedValue({ rows: [] });

            const res = await request(app)
                .get('/api/salary/is-closed')
                .query({ monthStr: '2026-06' });

            expect(res.status).toBe(200);
            expect(res.body.isClosed).toBe(false);
        });

        test('✅ Закрытый месяц — isClosed: true + total_taxes', async () => {
            mockPool._queryFn.mockResolvedValue({
                rows: [{ period_str: '2026-05', module: 'salary', total_taxes: 45000 }]
            });

            const res = await request(app)
                .get('/api/salary/is-closed')
                .query({ monthStr: '2026-05' });

            expect(res.status).toBe(200);
            expect(res.body.isClosed).toBe(true);
            expect(res.body.total_taxes).toBe(45000);
        });
    });

    // =========================================================
    // 6. GET /api/salary/balances — Динамические балансы
    // =========================================================
    describe('GET /api/salary/balances', () => {
        test('✅ Получение балансов сотрудников — успех', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('employees')) {
                    return { rows: [
                        { id: 1, full_name: 'Иванов И.И.', status: 'active', department: 'Производство', imprest_debt: '0', prev_balance: '5000' },
                        { id: 2, full_name: 'Петров П.П.', status: 'active', department: 'Офис', imprest_debt: '0', prev_balance: '-2000' }
                    ] };
                }
                return { rows: [] };
            });

            const res = await request(app)
                .get('/api/salary/balances')
                .query({ year: '2026', month: '06' });

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });
    });

    // =========================================================
    // 7. GET /api/salary/stats — Статистика по месяцу
    // =========================================================
    describe('GET /api/salary/stats', () => {
        test('✅ Получение статистики — возвращает массив', async () => {
            mockPool._queryFn.mockImplementation(async (text) => {
                if (text.includes('monthly_salary_stats')) {
                    return { rows: [
                        { employee_id: 1, month_str: '2026-06', salary_cash: '40000', salary_official: '20000', tax_rate: '13', tax_withheld: '2600' }
                    ] };
                }
                return { rows: [] };
            });

            const res = await request(app)
                .get('/api/salary/stats')
                .query({ year: '2026', month: '06' });

            expect(res.status).toBe(200);
            expect(res.body[0].tax_rate).toBe('13');
        });
    });
});
