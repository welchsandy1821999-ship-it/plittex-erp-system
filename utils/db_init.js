/**
 * utils/db_init.js — Автоматическое создание системных таблиц при старте
 */
const logger = require('./logger');

async function initSystemTables(pool) {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                username VARCHAR(100),
                action VARCHAR(100) NOT NULL,
                entity VARCHAR(100),
                entity_id INTEGER,
                details TEXT,
                ip_address VARCHAR(45),
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT,
                description VARCHAR(500)
            )
        `);

        // Индексы для audit_logs
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`);

        // Настройки по умолчанию (если пусты)
        await pool.query(`
            INSERT INTO system_settings (key, value, description)
            VALUES 
                ('company_name', 'ПЛИТТЕКС', 'Название компании'),
                ('backup_retention_days', '30', 'Срок хранения бэкапов (дней)'),
                ('vat_rate', '22', 'Ставка НДС (%)'),
                ('lock_finance_date', '', 'Дата блокировки редактирования финансов')
            ON CONFLICT (key) DO NOTHING
        `);

        logger.info('✅ Системные таблицы audit_logs и system_settings — готовы.');
    } catch (err) {
        logger.error(`❌ Ошибка создания системных таблиц: ${err.message}`);
    }
}

/**
 * Записывает событие в audit_logs.
 * Используется из роутов: auditLog(pool, req, 'delete_transaction', 'transaction', id, 'Удалена вручную')
 */
async function auditLog(pool, req, action, entity, entityId, details) {
    try {
        const userId = req.user ? req.user.id : null;
        const username = req.user ? req.user.username : 'system';
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        await pool.query(
            `INSERT INTO audit_logs (user_id, username, action, entity, entity_id, details, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, username, action, entity, entityId, details, ip]
        );
    } catch (err) {
        // Аудит не должен ронять основной процесс
        logger.error(`Audit log write failed: ${err.message}`);
    }
}

module.exports = { initSystemTables, auditLog };
