const cron = require('node-cron');
const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Запуск каждую субботу в 03:00 (ночь)
// cron.schedule('0 3 * * 6', async () => {
const initCronJobs = () => {
    logger.info('🕒 Планировщик задач инициализирован.');

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
