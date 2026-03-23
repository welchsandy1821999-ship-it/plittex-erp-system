const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot = null;

// Инициализируем бота только если есть токен
if (token) {
    bot = new TelegramBot(token, { polling: true });
    console.log('🤖 Telegram-бот запущен в интерактивном режиме');

    // === БЛОК ПЕРЕХВАТА СЕТЕВЫХ ОШИБОК ===
    // Перехватываем ошибки поллинга (те самые EFATAL), чтобы они не спамили в лог
    bot.on('polling_error', (error) => {
        // Telegram-бот сам умеет восстанавливать соединение. 
        // Мы просто "глотаем" ошибку, чтобы она не засоряла консоль Docker.
        // Если хочешь видеть, когда сеть моргает, раскомментируй строку ниже:
        // console.log(`[TG] Сетевая задержка: ${error.code}`);
    });

    // Перехват общих критических ошибок бота
    bot.on('error', (error) => {
        console.error('🔴 [TG] Критическая ошибка бота:', error.message);
    });
}

// Функция отправки уведомлений
const sendNotify = (message) => {
    if (!bot || !chatId) return;
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' })
       .catch(err => console.error('ТГ Ошибка отправки:', err.message)); // Оставил только сообщение, без огромного стека
};

// Экспортируем и функцию, и самого бота, и твой ID
module.exports = { sendNotify, bot, chatId };