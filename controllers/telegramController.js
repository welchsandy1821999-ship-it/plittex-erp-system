/**
 * Входящие команды Telegram-бота (long polling). Бизнес-запросы к БД только здесь или в роутере — не в web.js.
 */
const Big = require('big.js');
const { escapeHtml } = require('../utils/telegram');

/**
 * @param {import('node-telegram-bot-api')} bot
 * @param {import('pg').Pool} pool
 * @param {string|number|null|undefined} authorizedChatId — TELEGRAM_CHAT_ID из окружения
 */
module.exports = function registerTelegramMessageHandlers(bot, pool, authorizedChatId) {
    if (!bot) return;

    bot.on('message', async (msg) => {
        const currentChatId = msg.chat.id;
        if (String(currentChatId) !== String(authorizedChatId ?? '')) return;

        const text = msg.text || '';
        if (text === '/start') {
            return bot.sendMessage(currentChatId, '👋 Выберите команду:', {
                reply_markup: {
                    keyboard: [['💰 Баланс кассы', '📦 Остаток цемента'], ['📊 Отчет по продажам за сегодня']],
                    resize_keyboard: true
                }
            });
        }

        if (text === '💰 Баланс кассы' || text === '/balance') {
            try {
                const res = await pool.query('SELECT name, balance FROM accounts ORDER BY id ASC');
                let reply = '<b>🏦 Баланс:</b>\n\n';
                let total = new Big(0);
                res.rows.forEach((acc) => {
                    const b = new Big(acc.balance || 0);
                    reply += `🔹 ${escapeHtml(acc.name)}: ${Number(b.toFixed(2)).toLocaleString()} ₽\n`;
                    total = total.plus(b);
                });
                reply += `\n<b>💵 ИТОГО: ${Number(total.toFixed(2)).toLocaleString()} ₽</b>`;
                bot.sendMessage(currentChatId, reply, { parse_mode: 'HTML' });
            } catch (e) {
                bot.sendMessage(currentChatId, '❌ Ошибка БД');
            }
            return;
        }

        if (text === '📦 Остаток цемента') {
            try {
                const res = await pool.query(
                    `SELECT i.name, SUM(m.quantity) as total FROM inventory_movements m JOIN items i ON m.item_id = i.id WHERE i.name ILIKE '%цемент%' GROUP BY i.name`
                );
                if (res.rows.length === 0) {
                    bot.sendMessage(currentChatId, '🏗 Не найден.');
                    return;
                }
                let reply = '<b>🏗 Остатки цемента:</b>\n\n';
                res.rows.forEach((r) => {
                    reply += `• ${escapeHtml(r.name)}: ${parseFloat(r.total).toLocaleString()} кг\n`;
                });
                bot.sendMessage(currentChatId, reply, { parse_mode: 'HTML' });
            } catch (e) {
                bot.sendMessage(currentChatId, '❌ Ошибка');
            }
            return;
        }

        if (text === '📊 Отчет по продажам за сегодня') {
            try {
                const res = await pool.query(
                    `SELECT SUM(total_amount) as total, COUNT(*) as cnt FROM client_orders WHERE created_at::date = CURRENT_DATE AND status != 'cancelled'`
                );
                bot.sendMessage(
                    currentChatId,
                    `📈 <b>Сегодня:</b>\n\nЗаказов: ${res.rows[0]?.cnt || 0}\nСумма: ${parseFloat(res.rows[0]?.total || 0).toLocaleString()} ₽`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                bot.sendMessage(currentChatId, '❌ Ошибка');
            }
        }
    });
};
