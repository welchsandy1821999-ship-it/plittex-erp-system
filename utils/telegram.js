const TelegramBot = require('node-telegram-bot-api');
const logger = require('./logger');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot = null;

// Инициализируем бота только если есть токен
if (token) {
    bot = new TelegramBot(token, {
        polling: {
            interval: 300,
            autoStart: true,
            params: { timeout: 10 }
        }
    });
    logger.info('Telegram-бот запущен в интерактивном режиме (polling: interval=300ms, long-poll timeout=10s).');

    bot.on('polling_error', (error) => {
        const code = error && error.code !== undefined ? error.code : 'n/a';
        const msg = error && error.message ? error.message : String(error);
        logger.warn(`[TG] polling_error code=${code} ${msg}`);
    });

    // Перехват общих критических ошибок бота
    bot.on('error', (error) => {
        console.error('🔴 [TG] Критическая ошибка бота:', error.message);
    });
}

/** Экранирование произвольного текста под Telegram HTML (parse_mode HTML). */
function escapeHtml(value) {
    if (value == null || value === '') return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Функция отправки уведомлений
const sendNotify = (message) => {
    if (!bot || !chatId) return;
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' })
       .catch(err => console.error('ТГ Ошибка отправки:', err.message)); // Оставил только сообщение, без огромного стека
};

// Экспортируем и функцию, и самого бота, и твой ID
module.exports = { sendNotify, bot, chatId, escapeHtml };