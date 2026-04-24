const cron = require('node-cron');
const logger = require('./logger');
const { runBackup } = require('./backup');

/**
 * @param {import('pg').Pool} pool — тот же пул, что в web.js (DB_USER, DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT).
 *        Отдельный Pool здесь не создаётся, чтобы production использовал единую конфигурацию подключения.
 */
const initCronJobs = (pool) => {
    logger.info('🕒 Планировщик задач инициализирован.');

    // ═══════ 02:00 — Ежедневный бэкап БД (pg_dump) — runBackup() уже читает DB_* ═══════
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
