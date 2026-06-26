#!/usr/bin/env node
// comprehensive_check.js — ПОЛНАЯ диагностика: сравнение начислений по табелю vs salary_accrual транзакций

const { Client } = require('ssh2');
const conn = new Client();

function exec(conn, cmd) {
    return new Promise((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            let out = '';
            stream.on('data', d => { process.stdout.write(d.toString()); out += d; });
            stream.stderr.on('data', d => process.stdout.write('[E] ' + d.toString()));
            stream.on('close', () => resolve(out));
        });
    });
}

const Q = (sql) => `PGPASSWORD='ERP_secret_2026' psql -U plittex -h 127.0.0.1 -d plittex_erp -c "${sql.replace(/"/g, '\\"')}" 2>&1`;

conn.on('ready', async () => {
    console.log('=== ПОЛНАЯ ДИАГНОСТИКА ===\n');

    // 1. salary_stats — что хранится за каждый месяц?
    console.log('--- 1. monthly_salary_stats ---');
    await exec(conn, Q(`SELECT * FROM monthly_salary_stats ORDER BY month_str, employee_id`));

    // 2. Текущие ставки сотрудников
    console.log('\n--- 2. Текущие salary_cash сотрудников ---');
    await exec(conn, Q(`SELECT id, full_name, salary_cash, salary_official, tax_rate, tax_withheld, schedule_type FROM employees WHERE status='active' ORDER BY id`));

    // 3. Для каждого закрытого месяца: accrual из транзакций vs расчёт по табелю
    for (const month of ['2026-03', '2026-04', '2026-05']) {
        const [y, m] = month.split('-');
        console.log(`\n--- 3. ${month}: salary_accrual транзакции ---`);
        await exec(conn, Q(`
            SELECT t.employee_id, e.full_name, t.amount AS accrual_stored, t.system_type
            FROM transactions t
            JOIN employees e ON e.id = t.employee_id
            WHERE t.system_type IN ('salary_accrual', 'salary_legacy_action')
              AND t.transaction_type = 'income'
              AND t.description LIKE 'Начислено за период: ${month}'
              AND COALESCE(t.is_deleted, false) = false
            ORDER BY t.employee_id
        `));

        console.log(`\n--- 3. ${month}: расчёт earned по табелю (формула фронтенда) ---`);
        // Воспроизводим формулу фронтенда: для 5/2: salary_cash / normDays52, для 1/3: salary_cash / (daysInMonth/4)
        await exec(conn, Q(`
            WITH norm AS (
                SELECT 
                    (SELECT COUNT(*) FROM generate_series(
                        '${month}-01'::date,
                        ('${month}-01'::date + interval '1 month' - interval '1 day')::date,
                        '1 day'::interval
                    ) d WHERE EXTRACT(DOW FROM d) NOT IN (0, 6)) AS norm_days_52,
                    EXTRACT(DAY FROM ('${month}-01'::date + interval '1 month' - interval '1 day'))::int AS days_in_month
            ),
            emp_earned AS (
                SELECT 
                    e.id AS employee_id,
                    e.full_name,
                    e.salary_cash,
                    e.schedule_type,
                    CASE 
                        WHEN e.schedule_type = '5/2' THEN ROUND(e.salary_cash / n.norm_days_52)
                        ELSE ROUND(e.salary_cash / (n.days_in_month::numeric / 4))
                    END AS daily_cost,
                    COALESCE((
                        SELECT SUM(
                            CASE 
                                WHEN tr.status = 'present' THEN 
                                    COALESCE(tr.custom_rate, 
                                        CASE WHEN e.schedule_type='5/2' THEN ROUND(e.salary_cash / n.norm_days_52)
                                             ELSE ROUND(e.salary_cash / (n.days_in_month::numeric / 4)) END
                                    )
                                WHEN tr.status = 'partial' THEN 
                                    COALESCE(tr.custom_rate,
                                        CASE WHEN e.schedule_type='5/2' THEN ROUND(e.salary_cash / n.norm_days_52)
                                             ELSE ROUND(e.salary_cash / (n.days_in_month::numeric / 4)) END
                                    ) * COALESCE(tr.multiplier, 1.0)
                                ELSE 0
                            END
                            + COALESCE(tr.bonus, 0) - COALESCE(tr.penalty, 0)
                        )
                        FROM timesheet_records tr
                        WHERE tr.employee_id = e.id
                          AND tr.record_date >= '${month}-01'
                          AND tr.record_date < ('${month}-01'::date + interval '1 month')
                    ), 0) AS earned_from_timesheet
                FROM employees e, norm n
                WHERE e.status = 'active'
                   OR EXISTS (SELECT 1 FROM timesheet_records WHERE employee_id = e.id AND record_date >= '${month}-01' AND record_date < ('${month}-01'::date + interval '1 month'))
            )
            SELECT ee.employee_id, ee.full_name, ee.salary_cash, ee.schedule_type, ee.daily_cost, ee.earned_from_timesheet,
                   COALESCE((SELECT t.amount FROM transactions t 
                             WHERE t.employee_id = ee.employee_id 
                               AND t.system_type IN ('salary_accrual','salary_legacy_action')
                               AND t.transaction_type = 'income'
                               AND t.description LIKE 'Начислено за период: ${month}'
                               AND COALESCE(t.is_deleted,false) = false
                             LIMIT 1), 0) AS accrual_stored,
                   ee.earned_from_timesheet - COALESCE((SELECT t.amount FROM transactions t 
                             WHERE t.employee_id = ee.employee_id 
                               AND t.system_type IN ('salary_accrual','salary_legacy_action')
                               AND t.transaction_type = 'income'
                               AND t.description LIKE 'Начислено за период: ${month}'
                               AND COALESCE(t.is_deleted,false) = false
                             LIMIT 1), 0) AS DIFFERENCE
            FROM emp_earned ee
            WHERE ee.earned_from_timesheet > 0 OR COALESCE((SELECT t.amount FROM transactions t 
                             WHERE t.employee_id = ee.employee_id 
                               AND t.system_type IN ('salary_accrual','salary_legacy_action')
                               AND t.transaction_type = 'income'
                               AND t.description LIKE 'Начислено за период: ${month}'
                               AND COALESCE(t.is_deleted,false) = false
                             LIMIT 1), 0) > 0
            ORDER BY ee.employee_id
        `));
    }

    // 4. Закрытые периоды
    console.log('\n--- 4. Закрытые периоды ---');
    await exec(conn, Q(`SELECT * FROM closed_periods WHERE module='salary' ORDER BY period_str`));

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
