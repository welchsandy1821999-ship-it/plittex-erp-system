#!/usr/bin/env node
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
    // Payments in June 2026
    console.log('=== Salary payments in June 2026 ===\n');
    await exec(conn, Q(`
        SELECT sp.employee_id, e.full_name, SUM(sp.amount) as total_paid
        FROM salary_payments sp
        JOIN employees e ON sp.employee_id = e.id
        WHERE sp.payment_date >= '2026-06-01' AND sp.payment_date < '2026-07-01'
          AND COALESCE(sp.is_deleted, false) = false
        GROUP BY sp.employee_id, e.full_name
        ORDER BY total_paid DESC
    `));

    // Check if there are employees not in the list above
    console.log('\n=== Active employees NOT on screenshot ===');
    await exec(conn, Q(`
        SELECT id, full_name, exclude_from_salary FROM employees 
        WHERE status = 'active'
          AND full_name NOT IN ('Артемов Я.', 'Лоткина Е.Д.', 'Марченко С.М.', 'Москвичева И.Ю.', 'Петрива Н.', 'Рамазанова В.', 'Цебегеева Ю.')
        ORDER BY full_name
    `));

    conn.end();
}).on('error', e => console.error('SSH error:', e))
  .connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
