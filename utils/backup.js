/**
 * utils/backup.js — Автоматический бэкап PostgreSQL (custom format для pg_restore / pgAdmin).
 *
 * Формат: pg_dump -Fc → файл erp-backup-YYYY-MM-DD.backup
 * Переменная PG_DUMP_PATH — полный путь к pg_dump (например на Windows Server без PATH).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const RETENTION_DAYS = 30;

/**
 * Имя файла: erp-backup-2026-05-05.backup
 */
function getBackupFileName() {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    return `erp-backup-${date}.backup`;
}

/**
 * Удаляет бэкапы erp-backup-* старше RETENTION_DAYS (и .backup, и устаревшие .sql).
 */
function cleanOldBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return;

    const now = Date.now();
    const maxAge = RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const files = fs.readdirSync(BACKUP_DIR).filter(
        (f) => f.startsWith('erp-backup-') && (f.endsWith('.backup') || f.endsWith('.sql'))
    );

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
 * Запускает pg_dump в custom-формате. Возвращает Promise.
 * @returns {Promise<{ fileName: string, filePath: string, sizeKB: number, skipped?: boolean }>}
 */
function runBackup() {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }

        const fileName = getBackupFileName();
        const filePath = path.join(BACKUP_DIR, fileName);

        if (fs.existsSync(filePath)) {
            logger.info(`⏭️ Бэкап за сегодня уже существует: ${fileName}. Пропускаем создание.`);
            cleanOldBackups();
            const sizeKB = Math.round(fs.statSync(filePath).size / 1024);
            return resolve({ fileName, filePath, sizeKB, skipped: true });
        }

        const dbHost = process.env.DB_HOST || 'localhost';
        const dbPort = process.env.DB_PORT || '5432';
        const dbUser = process.env.DB_USER || 'postgres';
        const dbName = process.env.DB_NAME || 'plittex_erp';
        const dbPassword = process.env.DB_PASSWORD || '';
        const pgDumpBinary = (String(process.env.PG_DUMP_PATH || '').trim() || 'pg_dump');

        const env = { ...process.env, PGPASSWORD: dbPassword };
        const args = [
            '-h', dbHost,
            '-p', String(dbPort),
            '-U', dbUser,
            '-d', dbName,
            '--no-owner',
            '--no-acl',
            '-Fc',
            '-f', filePath
        ];

        logger.info(`💾 Запуск бэкапа: ${fileName} («${pgDumpBinary}»)...`);
        const startTime = Date.now();

        const child = spawn(pgDumpBinary, args, { env, windowsHide: true });

        let stderrBuf = '';
        child.stderr.on('data', (chunk) => {
            stderrBuf += String(chunk || '');
        });

        child.on('error', (err) => {
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
            }
            const hint = 'Проверьте PG_DUMP_PATH в .env (полный путь к pg_dump.exe на Windows).';
            const msg = err.code === 'ENOENT'
                ? `Не найден исполняемый файл pg_dump: "${pgDumpBinary}". ${hint}`
                : `Не удалось запустить pg_dump («${pgDumpBinary}»): ${err.message}. ${hint}`;
            logger.error(`❌ Ошибка бэкапа: ${msg}`);
            reject(new Error(msg));
        });

        child.on('close', (code) => {
            const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

            if (code !== 0) {
                if (fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
                }
                const tail = stderrBuf.trim() || 'Подробности отсутствуют.';
                const msg = `pg_dump завершился с кодом ${code}. ${tail}`;
                logger.error(`❌ Ошибка бэкапа: ${msg}`);
                return reject(new Error(msg));
            }

            if (!fs.existsSync(filePath)) {
                const msg = `Бэкап не создан: файл ${fileName} не найден после pg_dump.`;
                logger.error(`❌ ${msg}`);
                return reject(new Error(msg));
            }

            const sizeKB = Math.round(fs.statSync(filePath).size / 1024);
            logger.info(`✅ Бэкап завершён: ${fileName} (${sizeKB} KB, ${durationSec}с)`);
            cleanOldBackups();
            resolve({ fileName, filePath, sizeKB, skipped: false });
        });
    });
}

module.exports = { runBackup, cleanOldBackups, BACKUP_DIR };
