/**
 * utils/backup.js — Автоматический бэкап PostgreSQL
 * 
 * Использует pg_dump для создания SQL-дампа базы данных.
 * Сохраняет в ./backups/ с ротацией 30 дней.
 */
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const RETENTION_DAYS = 30;

/**
 * Формирует имя файла бэкапа: erp-backup-2026-04-11.sql
 */
function getBackupFileName() {
    const now = new Date();
    const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
    return `erp-backup-${date}.sql`;
}

/**
 * Удаляет файлы бэкапов старше RETENTION_DAYS дней.
 */
function cleanOldBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return;

    const now = Date.now();
    const maxAge = RETENTION_DAYS * 24 * 60 * 60 * 1000; // 30 дней в мс

    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('erp-backup-') && f.endsWith('.sql'));

    let deleted = 0;
    for (const file of files) {
        const filePath = path.join(BACKUP_DIR, file);
        const stat = fs.statSync(filePath);
        const age = now - stat.mtimeMs;

        if (age > maxAge) {
            fs.unlinkSync(filePath);
            deleted++;
            logger.info(`🗑️ Удалён старый бэкап: ${file} (возраст: ${Math.round(age / 86400000)} дн.)`);
        }
    }

    if (deleted > 0) {
        logger.info(`🧹 Ротация бэкапов: удалено ${deleted} файл(ов) старше ${RETENTION_DAYS} дней.`);
    }
}

/**
 * Выполняет pg_dump и сохраняет дамп в ./backups/
 */
function runBackup() {
    // Создаём папку, если не существует
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const fileName = getBackupFileName();
    const filePath = path.join(BACKUP_DIR, fileName);

    // Проверяем, не существует ли уже бэкап за сегодня
    if (fs.existsSync(filePath)) {
        logger.info(`⏭️ Бэкап за сегодня уже существует: ${fileName}. Пропускаем.`);
        cleanOldBackups();
        return;
    }

    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbUser = process.env.DB_USER || 'postgres';
    const dbName = process.env.DB_NAME || 'plittex_erp';
    const dbPassword = process.env.DB_PASSWORD || '';

    // pg_dump через PGPASSWORD (безопасный способ передачи пароля)
    const env = { ...process.env, PGPASSWORD: dbPassword };
    const cmd = `pg_dump -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} --no-owner --no-acl -f "${filePath}"`;

    logger.info(`💾 Запуск бэкапа: ${fileName}...`);
    const startTime = Date.now();

    exec(cmd, { env, timeout: 120000 }, (error, stdout, stderr) => {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        if (error) {
            logger.error(`❌ Ошибка бэкапа: ${error.message}`);
            // Удаляем пустой/битый файл, если он был создан
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            }
            return;
        }

        // Проверяем размер файла
        if (fs.existsSync(filePath)) {
            const sizeKB = Math.round(fs.statSync(filePath).size / 1024);
            logger.info(`✅ Бэкап завершён: ${fileName} (${sizeKB} KB, ${duration}с)`);
        } else {
            logger.error(`❌ Бэкап не создан: файл ${fileName} не найден после pg_dump.`);
        }

        // Очистка старых бэкапов после успешного создания нового
        cleanOldBackups();
    });
}

module.exports = { runBackup, cleanOldBackups, BACKUP_DIR };
