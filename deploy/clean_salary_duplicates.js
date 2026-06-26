#!/usr/bin/env node
// clean_salary_duplicates.js — очистка дубликатов ЗП и корректировок

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

const SQL_SCRIPT = `
BEGIN;

-- 1. Удаление дубликатов корректировок (созданных кнопкой Закрыть месяц)
UPDATE transactions 
SET is_deleted = true
WHERE system_type = 'salary_period_adjustment' 
  AND description LIKE 'Доп. корректировки за период:%'
  AND COALESCE(is_deleted, false) = false;

-- 2. Восстановление оригинальных ручных корректировок, удаленных по ошибке при Отмене закрытия
UPDATE transactions 
SET is_deleted = false
WHERE system_type = 'salary_period_adjustment' 
  AND description NOT LIKE 'Доп. корректировки за период:%'
  AND is_deleted = true;

-- 3. Восстановление удержаний за подотчет, удаленных по ошибке при Отмене закрытия
UPDATE transactions
SET is_deleted = false
WHERE system_type = 'salary_imprest_deduction'
  AND is_deleted = true;

-- 4. Удаление старых дублирующих начислений (legacy), которые теперь задваиваются с salary_accrual
UPDATE transactions 
SET is_deleted = true
WHERE system_type = 'salary_legacy_action' 
  AND (description LIKE 'Начислено за период:%' OR description LIKE 'Налог за период:%')
  AND COALESCE(is_deleted, false) = false;

-- 5. Для уверенности: таблица salary_adjustments содержит некоторые записи is_deleted = true. 
-- Если это была отмена закрытия, возможно, их тоже стоит восстановить?
-- Нет, salary_adjustments не удалялись при отмене закрытия в hr.js (удалялись только где operation_kind='imprest_settlement').
-- Восстановим только 'imprest_settlement', удаленные при reopenMonth:
UPDATE salary_adjustments
SET is_deleted = false
WHERE operation_kind = 'imprest_settlement'
  AND is_deleted = true;

COMMIT;
`;

const Q = (sql) => `PGPASSWORD='ERP_secret_2026' psql -U plittex -h 127.0.0.1 -d plittex_erp -c "${sql.replace(/"/g, '\\"')}" 2>&1`;

conn.on('ready', async () => {
    console.log('--- ЗАПУСК ОЧИСТКИ БАЗЫ ---');
    await exec(conn, Q(SQL_SCRIPT));
    console.log('--- ОЧИСТКА УСПЕШНО ЗАВЕРШЕНА ---');
    conn.end();
}).on('error', e => console.error('SSH error:', e)).connect({ host: '159.194.207.6', port: 22, username: 'root', password: '+JjJWwaK5+6b' });
