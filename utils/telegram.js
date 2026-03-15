const TelegramBot = require('node-telegram-bot-api');
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot = null;
if (token && chatId) {
    bot = new TelegramBot(token, { polling: false }); // Работаем только на отправку
}

const sendNotify = async (message) => {
    if (!bot) return;
    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (err) {
        console.error('Ошибка Telegram (возможно нет интернета):', err.message);
    }
};
module.exports = { sendNotify };