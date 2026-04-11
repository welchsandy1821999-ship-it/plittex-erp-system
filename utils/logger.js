const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const Sentry = require('@sentry/node');
const path = require('path');
const fs = require('fs');

const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

// === Winston Logger ===
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new DailyRotateFile({
            filename: path.join(logDir, 'erp-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxFiles: '30d' // Храним историю за 30 дней
        })
    ]
});

// === Sentry Bridge ===
// Перехватываем logger.error() и дублируем ошибку в Sentry (если инициализирован)
const originalError = logger.error.bind(logger);
logger.error = function (msgOrError, ...args) {
    // 1. Пишем в Winston (файлы + консоль) как обычно
    originalError(typeof msgOrError === 'object' && msgOrError.message ? msgOrError.message : msgOrError, ...args);

    // 2. Дублируем в Sentry (если DSN настроен)
    if (process.env.SENTRY_DSN) {
        if (msgOrError instanceof Error) {
            Sentry.captureException(msgOrError);
        } else {
            Sentry.captureMessage(String(msgOrError), 'error');
        }
    }
};

module.exports = logger;