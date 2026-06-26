#!/usr/bin/env node
// salary_audit2.js — дополнительная проверка (1-6 пункты подробнее)

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
    console.log('=== АУДИТ ЗАРПЛАТЫ (Часть 2) ===\n');

    // Закрытые периоды
    console.log('--- Закрытые периоды ---');
    await exec(conn, Q("SELECT * FROM closed_periods WHERE module='salary' ORDER BY period_str;"));

    // employees.prev_balance сейчас
    console.log('\n--- employees.prev_balance (текущее значение в таблице) ---');
    await exec(conn, Q("SELECT id, full_name, prev_balance FROM employees WHERE status='active' ORDER BY id;"));

    // Сравнение: К ВЫДАЧЕ за Апрель vs ± Остаток на Май
    // К ВЫДАЧЕ = earnedToday - tax + prevBalance - advances + adjSum
    // Для Бодничарчук: earned=54094, prevBalance=465355.90, tax=0, advances=63893, adj=0
    // К ВЫДАЧЕ = 54094 + 465355.90 - 0 - 63893 + 0 = 455556.9 (совпадает со скриншотом)

    // На следующий месяц (Май):
    // ± Остаток = 452374.90 (из запроса 8)
    // НО на скриншоте ± ОСТАТОК Май для Боднарчук = +452 374,9

    // Проверяем транзакции за Апрель для Боднарчука
    console.log('\n--- Транзакции Боднарчука за Апрель 2026 ---');
    await exec(conn, Q("SELECT t.id, t.amount, t.transaction_type, t.system_type, t.category, t.transaction_date::date, t.description FROM transactions t WHERE (t.employee_id=14 OR t.counterparty_id IN (SELECT id FROM counterparties WHERE employee_id=14)) AND (t.source_module='salary' OR t.system_type LIKE 'salary_%' OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков')) AND t.transaction_date >= '2026-04-01' AND t.transaction_date < '2026-05-01' AND COALESCE(t.is_deleted,false)=false ORDER BY t.transaction_date;"));

    // Выплаты Боднарчука за Апрель
    console.log('\n--- Выплаты Боднарчука за Апрель ---');
    await exec(conn, Q("SELECT * FROM salary_payments WHERE employee_id=14 AND payment_date >= '2026-04-01' AND payment_date < '2026-05-01' AND COALESCE(is_deleted,false)=false;"));

    // Все salary_payments за Май 2026
    console.log('\n--- Все выплаты за Май 2026 ---');
    await exec(conn, Q("SELECT sp.employee_id, e.full_name, sp.amount, sp.payment_date::date FROM salary_payments sp JOIN employees e ON e.id=sp.employee_id WHERE sp.payment_date >= '2026-05-01' AND sp.payment_date < '2026-06-01' AND COALESCE(sp.is_deleted,false)=false ORDER BY sp.employee_id;"));

    // Все транзакции с category 'Ввод начальных остатков'
    console.log('\n--- Транзакции Ввод начальных остатков ---');
    await exec(conn, Q("SELECT t.id, t.employee_id, e.full_name, t.amount, t.transaction_type, t.transaction_date::date FROM transactions t LEFT JOIN employees e ON e.id=t.employee_id WHERE t.category='Ввод начальных остатков' AND COALESCE(t.is_deleted,false)=false ORDER BY t.transaction_date;"));

    // Проверяем разницу: balance_before_may - balance_before_apr
    console.log('\n--- Разница (balance_before_may - balance_before_apr) = net_change за Апрель ---');
    await exec(conn, Q("SELECT e.id, e.full_name, COALESCE((SELECT SUM(CASE WHEN t.transaction_type='income' THEN t.amount ELSE -t.amount END) FROM transactions t LEFT JOIN counterparties cp ON t.counterparty_id=cp.id WHERE (t.employee_id=e.id OR cp.employee_id=e.id) AND (t.source_module='salary' OR t.system_type IN ('salary_payment','salary_imprest_deduction','salary_accrual','salary_tax_withhold','salary_period_adjustment') OR t.category IN ('Начисление ЗП','Зарплата','Оплата труда','Зарплата и Авансы','Премии','Штрафы','Удержание из ЗП','Ввод начальных остатков')) AND t.transaction_date >= '2026-04-01' AND t.transaction_date < '2026-05-01' AND COALESCE(t.is_deleted,false)=false),0) AS apr_net FROM employees e WHERE e.status='active' ORDER BY e.id;"));

    conn.end();
    console.log('\n=== DONE ===');
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
