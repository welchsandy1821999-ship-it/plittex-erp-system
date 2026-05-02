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

        await pool.query(`
            CREATE TABLE IF NOT EXISTS report_presets (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                name VARCHAR(150) NOT NULL,
                report_type VARCHAR(100) NOT NULL,
                payload JSONB NOT NULL,
                is_shared BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS report_runs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                username VARCHAR(100),
                report_type VARCHAR(100) NOT NULL,
                date_from DATE,
                date_to DATE,
                accounting_mode VARCHAR(20),
                format VARCHAR(20),
                rows_count INTEGER,
                payload JSONB,
                payload_hash VARCHAR(64),
                preflight_status VARCHAR(20),
                preflight_reason TEXT,
                generated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS payload JSONB`);
        await pool.query(`ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS payload_hash VARCHAR(64)`);
        await pool.query(`ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS preflight_status VARCHAR(20)`);
        await pool.query(`ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS preflight_reason TEXT`);

        await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_presets_user ON report_presets(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_runs_type ON report_runs(report_type, generated_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_runs_preflight ON report_runs(preflight_status, generated_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_runs_payload_hash ON report_runs(payload_hash)`);

        // Миграция: поле default_layer в items — единая точка истины для авто-суггестии слоя при добавлении сырья
        await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS default_layer VARCHAR(20) DEFAULT 'main'`);
        // Предзаполнение: упаковочные материалы
        await pool.query(`
            UPDATE items SET default_layer = 'packaging'
            WHERE item_type = 'material'
              AND default_layer = 'main'
              AND (
                name ILIKE '%упаков%' OR name ILIKE '%паллет%' OR name ILIKE '%поддон%'
                OR name ILIKE '%пленк%' OR name ILIKE '%стреп%' OR name ILIKE '%этикет%'
                OR name ILIKE '%мешок%' OR category ILIKE '%упаков%'
              )
        `);
        // Предзаполнение: лицевые материалы
        await pool.query(`
            UPDATE items SET default_layer = 'face'
            WHERE item_type = 'material'
              AND default_layer = 'main'
              AND (
                name ILIKE '%пигмент%' OR name ILIKE '%красит%'
                OR name ILIKE '%белый цемент%' OR name ILIKE '%диоксид%'
                OR name ILIKE '%пластификатор лиц%'
              )
        `);

        // Настройки по умолчанию (если пусты)
        await pool.query(`
            INSERT INTO system_settings (key, value, description)
            VALUES 
                ('company_name', 'ПЛИТТЕКС', 'Название компании'),
                ('company_inn', '', 'ИНН компании'),
                ('company_kpp', '', 'КПП компании'),
                ('company_address', '', 'Юридический адрес компании'),
                ('company_director', '', 'ФИО руководителя'),
                ('company_accountant', '', 'ФИО главного бухгалтера'),
                ('reports_preflight_mode', 'warning', 'Режим preflight для отчетов: warning | hard_fail'),
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
