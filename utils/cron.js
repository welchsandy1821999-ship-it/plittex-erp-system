const cron = require('node-cron');
const { Pool } = require('pg');
const logger = require('./logger');
const { runBackup } = require('./backup');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const initCronJobs = () => {
    logger.info('🕒 Планировщик задач инициализирован.');

    // ═══════ 02:00 — Ежедневный бэкап БД (pg_dump) ═══════
    cron.schedule('0 2 * * *', () => {
        logger.info('💾 [CRON] Запуск ежедневного бэкапа БД...');
        runBackup();
    });

    // ═══════ 03:00 (воскресенье) — Обслуживание БД (VACUUM) ═══════
    cron.schedule('0 3 * * 0', async () => {
        logger.info('🧹 Запуск автоматического обслуживания БД (VACUUM ANALYZE)...');
        let client;
        try {
            client = await pool.connect();
            
            // PostgreSQL не позволяет запускать VACUUM внутри блока транзакции (BEGIN ... COMMIT)
            // Поэтому мы не используем стандартный web.js withTransaction
            
            logger.info('Выполняем VACUUM ANALYZE для inventory_movements...');
            await client.query('VACUUM ANALYZE inventory_movements');
            
            logger.info('Выполняем VACUUM ANALYZE для transactions...');
            await client.query('VACUUM ANALYZE transactions');
            
            logger.info('✅ Обслуживание БД успешно завершено.');
        } catch (error) {
            logger.error(`❌ Ошибка во время выполнения VACUUM: ${error.message}`);
        } finally {
            if (client) client.release();
        }
    });
};

module.exports = { initCronJobs };
