const cron = require('node-cron');
const logger = require('./logger');
const { runBackup } = require('./backup');
const { sendNotify, escapeHtml } = require('./telegram');

/**
 * @param {import('pg').Pool} pool — тот же пул, что в web.js (DB_USER, DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT).
 *        Отдельный Pool здесь не создаётся, чтобы production использовал единую конфигурацию подключения.
 */
const initCronJobs = (pool) => {
    logger.info('🕒 Планировщик задач инициализирован.');

    // ═══════ 02:00 — Ежедневный бэкап БД (pg_dump) — runBackup() уже читает DB_* ═══════
    cron.schedule('0 2 * * *', () => {
        logger.info('💾 [CRON] Запуск ежедневного бэкапа БД...');
        runBackup().catch((err) => {
            logger.error(`❌ [CRON] Бэкап БД завершился с ошибкой: ${err.message}`);
            sendNotify(`🚨 <b>ОШИБКА БЭКАПА БД!</b>\nНочной бэкап не был создан.\nДетали: ${escapeHtml(err.message)}`);
        });
    });

    // ═══════ 03:00 (воскресенье) — Обслуживание БД (VACUUM) ═══════
    cron.schedule('0 3 * * 0', async () => {
        logger.info('🧹 Запуск автоматического обслуживания БД (VACUUM ANALYZE)...');
        let client;
        const startedAt = Date.now();
        const tables = [
            'inventory_movements',
            'transactions',
            'client_orders',
            'client_order_items',
            'production_batches',
            'invoices'
        ];
        try {
            client = await pool.connect();

            // PostgreSQL не позволяет запускать VACUUM внутри блока транзакции (BEGIN ... COMMIT)
            // Поэтому мы не используем стандартный web.js withTransaction

            for (const table of tables) {
                const t0 = Date.now();
                logger.info(`Выполняем VACUUM ANALYZE для ${table}...`);
                // whitelist: таблицы берём только из фиксированного массива
                await client.query(`VACUUM ANALYZE ${table}`);
                logger.info(`✅ VACUUM ANALYZE ${table} завершён за ${Date.now() - t0}ms`);
            }

            logger.info(`✅ Обслуживание БД успешно завершено за ${Date.now() - startedAt}ms.`);
        } catch (error) {
            logger.error(`❌ Ошибка во время выполнения VACUUM: ${error.message}`);
        } finally {
            if (client) client.release();
        }
    });
};

module.exports = { initCronJobs };
