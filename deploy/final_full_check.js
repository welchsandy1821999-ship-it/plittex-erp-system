#!/usr/bin/env node
// final_full_check.js — финальная полная таблица: К ВЫДАЧЕ vs ± Остаток для ВСЕХ

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

// Функция расчёта баланса (новая архитектура)
const balanceSQL = (monthStr) => `
    COALESCE(
        (SELECT SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE -t.amount END)
         FROM transactions t
         LEFT JOIN counterparties cp ON t.counterparty_id = cp.id
         WHERE (t.employee_id = e.id OR cp.employee_id = e.id)
           AND (
               t.source_module = 'salary'
               OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_legacy_action')
               OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков')
           )
           AND COALESCE(t.system_type, '') NOT IN ('salary_period_adjustment', 'salary_adjustment_cash_in', 'salary_adjustment_cash_out')
           AND t.transaction_date <= ('${monthStr}' || '-01')::timestamp
           AND COALESCE(t.is_deleted, false) = false
        ), 0
    )
    +
    COALESCE(
        (SELECT SUM(sa.amount)
         FROM salary_adjustments sa
         WHERE sa.employee_id = e.id
           AND sa.month_str < '${monthStr}'
           AND COALESCE(sa.is_deleted, false) = false
        ), 0
    )
`;

conn.on('ready', async () => {
    console.log('=== ФИНАЛЬНАЯ ПОЛНАЯ ПРОВЕРКА ===\n');
    console.log('Формула: К_ВЫДАЧЕ = Earned - Tax + PrevBalance - Advances + AdjSum');
    console.log('Если DIFF = 0, то К_ВЫДАЧЕ = ± Остаток_следующего_месяца\n');

    for (const month of ['2026-03', '2026-04', '2026-05']) {
        const [y, m] = month.split('-');
        const nextMonth = m === '12' ? `${parseInt(y)+1}-01` : `${y}-${String(parseInt(m)+1).padStart(2,'0')}`;
        
        console.log(`\n${'='.repeat(120)}`);
        console.log(`МЕСЯЦ: ${month} → переход в ${nextMonth}`);
        console.log(`${'='.repeat(120)}`);

        await exec(conn, Q(`
            WITH norm AS (
                SELECT 
                    (SELECT COUNT(*) FROM generate_series(
                        '${month}-01'::date,
                        ('${month}-01'::date + interval '1 month' - interval '1 day')::date,
                        '1 day'::interval
                    ) d WHERE EXTRACT(DOW FROM d) NOT IN (0, 6)) AS norm52,
                    EXTRACT(DAY FROM ('${month}-01'::date + interval '1 month' - interval '1 day'))::int AS dim
            )
            SELECT 
                e.id,
                e.full_name AS name,
                
                -- Earned (из табеля, повторяя формулу фронтенда)
                COALESCE((
                    SELECT SUM(
                        CASE 
                            WHEN tr.status = 'present' THEN COALESCE(tr.custom_rate, 
                                CASE WHEN e.schedule_type='5/2' THEN ROUND(e.salary_cash / n.norm52)
                                     ELSE ROUND(e.salary_cash / (n.dim::numeric / 4)) END)
                            WHEN tr.status = 'partial' THEN COALESCE(tr.custom_rate,
                                CASE WHEN e.schedule_type='5/2' THEN ROUND(e.salary_cash / n.norm52)
                                     ELSE ROUND(e.salary_cash / (n.dim::numeric / 4)) END
                            ) * COALESCE(tr.multiplier, 1.0)
                            ELSE 0
                        END + COALESCE(tr.bonus, 0) - COALESCE(tr.penalty, 0)
                    )
                    FROM timesheet_records tr
                    WHERE tr.employee_id = e.id
                      AND tr.record_date >= '${month}-01'
                      AND tr.record_date < ('${month}-01'::date + interval '1 month')
                ), 0)::numeric(12,2) AS earned,
                
                -- Tax
                COALESCE(e.tax_withheld, 0)::numeric(12,2) AS tax,
                
                -- PrevBalance (новая архитектура)
                (${balanceSQL(month)})::numeric(12,2) AS prev_bal,
                
                -- Advances (из salary_payments)
                COALESCE((SELECT SUM(sp.amount) FROM salary_payments sp 
                          WHERE sp.employee_id = e.id 
                            AND sp.payment_date >= '${month}-01'
                            AND sp.payment_date < ('${month}-01'::date + interval '1 month')
                            AND COALESCE(sp.is_deleted, false) = false
                         ), 0)::numeric(12,2) AS advances,
                
                -- AdjSum (из salary_adjustments за этот месяц)
                COALESCE((SELECT SUM(sa.amount) FROM salary_adjustments sa 
                          WHERE sa.employee_id = e.id AND sa.month_str = '${month}'
                            AND COALESCE(sa.is_deleted, false) = false
                         ), 0)::numeric(12,2) AS adj_sum,
                
                -- К ВЫДАЧЕ = earned - tax + prevBal - advances + adj
                (
                    COALESCE((
                        SELECT SUM(
                            CASE 
                                WHEN tr.status = 'present' THEN COALESCE(tr.custom_rate,
                                    CASE WHEN e.schedule_type='5/2' THEN ROUND(e.salary_cash / n.norm52)
                                         ELSE ROUND(e.salary_cash / (n.dim::numeric / 4)) END)
                                WHEN tr.status = 'partial' THEN COALESCE(tr.custom_rate,
                                    CASE WHEN e.schedule_type='5/2' THEN ROUND(e.salary_cash / n.norm52)
                                         ELSE ROUND(e.salary_cash / (n.dim::numeric / 4)) END
                                ) * COALESCE(tr.multiplier, 1.0)
                                ELSE 0
                            END + COALESCE(tr.bonus, 0) - COALESCE(tr.penalty, 0)
                        )
                        FROM timesheet_records tr
                        WHERE tr.employee_id = e.id
                          AND tr.record_date >= '${month}-01'
                          AND tr.record_date < ('${month}-01'::date + interval '1 month')
                    ), 0)
                    - COALESCE(e.tax_withheld, 0)
                    + (${balanceSQL(month)})
                    - COALESCE((SELECT SUM(sp.amount) FROM salary_payments sp 
                                WHERE sp.employee_id = e.id 
                                  AND sp.payment_date >= '${month}-01'
                                  AND sp.payment_date < ('${month}-01'::date + interval '1 month')
                                  AND COALESCE(sp.is_deleted, false) = false), 0)
                    + COALESCE((SELECT SUM(sa.amount) FROM salary_adjustments sa 
                                WHERE sa.employee_id = e.id AND sa.month_str = '${month}'
                                  AND COALESCE(sa.is_deleted, false) = false), 0)
                )::numeric(12,2) AS k_vydache,
                
                -- ± Остаток следующего месяца (из новой архитектуры)
                (${balanceSQL(nextMonth)})::numeric(12,2) AS next_prev_bal,
                
                -- РАЗНИЦА
                (
                    (
                        COALESCE((
                            SELECT SUM(
                                CASE 
                                    WHEN tr.status = 'present' THEN COALESCE(tr.custom_rate,
                                        CASE WHEN e.schedule_type='5/2' THEN ROUND(e.salary_cash / n.norm52)
                                             ELSE ROUND(e.salary_cash / (n.dim::numeric / 4)) END)
                                    WHEN tr.status = 'partial' THEN COALESCE(tr.custom_rate,
                                        CASE WHEN e.schedule_type='5/2' THEN ROUND(e.salary_cash / n.norm52)
                                             ELSE ROUND(e.salary_cash / (n.dim::numeric / 4)) END
                                    ) * COALESCE(tr.multiplier, 1.0)
                                    ELSE 0
                                END + COALESCE(tr.bonus, 0) - COALESCE(tr.penalty, 0)
                            )
                            FROM timesheet_records tr
                            WHERE tr.employee_id = e.id
                              AND tr.record_date >= '${month}-01'
                              AND tr.record_date < ('${month}-01'::date + interval '1 month')
                        ), 0)
                        - COALESCE(e.tax_withheld, 0)
                        + (${balanceSQL(month)})
                        - COALESCE((SELECT SUM(sp.amount) FROM salary_payments sp 
                                    WHERE sp.employee_id = e.id 
                                      AND sp.payment_date >= '${month}-01'
                                      AND sp.payment_date < ('${month}-01'::date + interval '1 month')
                                      AND COALESCE(sp.is_deleted, false) = false), 0)
                        + COALESCE((SELECT SUM(sa.amount) FROM salary_adjustments sa 
                                    WHERE sa.employee_id = e.id AND sa.month_str = '${month}'
                                      AND COALESCE(sa.is_deleted, false) = false), 0)
                    )
                    - (${balanceSQL(nextMonth)})
                )::numeric(12,2) AS DIFF
            FROM employees e, norm n
            WHERE e.status = 'active'
               OR EXISTS (SELECT 1 FROM timesheet_records WHERE employee_id = e.id AND record_date >= '${month}-01' AND record_date < ('${month}-01'::date + interval '1 month'))
            ORDER BY e.id
        `));
    }

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
