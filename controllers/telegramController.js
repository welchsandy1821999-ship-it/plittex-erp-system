/**
 * Входящие команды Telegram-бота (long polling).
 */
const Big = require('big.js');
const logger = require('../utils/logger');
const { escapeHtml } = require('../utils/telegram');

const KB = {
    REPORTS: '📊 Отчеты',
    FINANCE: '💰 Финансы',
    WAREHOUSE: '🏗 Склад',
    REFRESH: '🔄 Обновить данные'
};

/** Тексты старого Reply-меню (дублируют SQL). */
const LEGACY = {
    BALANCE: '💰 Баланс кассы',
    CEMENT: '📦 Остаток цемента',
    SALES_TODAY: '📊 Отчет по продажам за сегодня'
};

const CB = {
    REPORT_SALES: 'tg:r:sales',
    REPORT_CEMENT: 'tg:r:cement',
    REPORT_ORDERS: 'tg:r:orders',
    FIN_BALANCE: 'tg:f:balance',
    WH_CEMENT: 'tg:w:cement'
};

function mainReplyKeyboard() {
    return {
        keyboard: [
            [KB.REPORTS, KB.FINANCE],
            [KB.WAREHOUSE, KB.REFRESH]
        ],
        resize_keyboard: true
    };
}

async function buildBalanceMessage(pool) {
    const res = await pool.query('SELECT name, balance FROM accounts ORDER BY id ASC');
    let reply = '<b>🏦 Баланс:</b>\n\n';
    let total = new Big(0);
    res.rows.forEach((acc) => {
        const b = new Big(acc.balance || 0);
        reply += `🔹 ${escapeHtml(acc.name)}: ${Number(b.toFixed(2)).toLocaleString()} ₽\n`;
        total = total.plus(b);
    });
    reply += `\n<b>💵 ИТОГО: ${Number(total.toFixed(2)).toLocaleString()} ₽</b>`;
    return reply;
}

async function buildCementMessage(pool) {
    const res = await pool.query(
        `SELECT i.name, SUM(m.quantity) as total FROM inventory_movements m JOIN items i ON m.item_id = i.id WHERE i.name ILIKE '%цемент%' GROUP BY i.name`
    );
    if (res.rows.length === 0) return '🏗 <b>Остатки цемента:</b>\n\nНе найдено.';
    let reply = '<b>🏗 Остатки цемента:</b>\n\n';
    res.rows.forEach((r) => {
        reply += `• ${escapeHtml(r.name)}: ${parseFloat(r.total).toLocaleString()} кг\n`;
    });
    return reply;
}

async function buildSalesTodayMessage(pool) {
    const res = await pool.query(
        `SELECT SUM(total_amount) as total, COUNT(*) as cnt FROM client_orders WHERE created_at::date = CURRENT_DATE AND status != 'cancelled'`
    );
    return `📈 <b>Сегодня:</b>\n\nЗаказов: ${res.rows[0]?.cnt || 0}\nСумма: ${parseFloat(res.rows[0]?.total || 0).toLocaleString()} ₽`;
}

async function buildOrdersInWorkMessage(pool) {
    const res = await pool.query(
        `SELECT doc_number, status, total_amount, pending_debt, created_at
         FROM client_orders
         WHERE status IN ('pending', 'processing')
         ORDER BY created_at DESC
         LIMIT 25`
    );
    if (res.rows.length === 0) {
        return '📋 <b>Заказы в работе</b>\n\nАктивных заказов (pending / processing) нет.';
    }
    let reply = '📋 <b>Заказы в работе</b> (до 25 строк):\n\n';
    res.rows.forEach((row) => {
        reply += `• <b>${escapeHtml(row.doc_number)}</b> — ${escapeHtml(row.status)}\n`;
        reply += `  сумма ${Number(row.total_amount || 0).toLocaleString()} ₽, долг ${Number(row.pending_debt || 0).toLocaleString()} ₽\n`;
    });
    return reply;
}

/**
 * @param {import('node-telegram-bot-api')} bot
 * @param {import('pg').Pool} pool
 * @param {string|number|null|undefined} authorizedChatId
 */
module.exports = function registerTelegramMessageHandlers(bot, pool, authorizedChatId) {
    if (!bot) return;

    function authorizedChat(cid) {
        return String(cid) === String(authorizedChatId ?? '');
    }

    async function safeAnswerCallback(queryId, opts) {
        try {
            await bot.answerCallbackQuery(queryId, opts);
        } catch (e) {
            logger.warn(`[TG] answerCallbackQuery: ${e.message || e}`);
        }
    }

    bot.on('message', async (msg) => {
        const currentChatId = msg.chat.id;
        if (!authorizedChat(currentChatId)) return;

        const text = (msg.text || '').trim();

        if (!text || text.startsWith('/start')) {
            return bot.sendMessage(currentChatId, '👋 <b>Главное меню</b>\nВыберите раздел кнопками ниже.', {
                parse_mode: 'HTML',
                reply_markup: mainReplyKeyboard()
            });
        }

        if (text === KB.REPORTS) {
            return bot.sendMessage(currentChatId, '📊 <b>Отчёты</b>\nВыберите:', {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Продажи за сегодня', callback_data: CB.REPORT_SALES }],
                        [{ text: 'Остатки цемента', callback_data: CB.REPORT_CEMENT }],
                        [{ text: 'Заказы в работе', callback_data: CB.REPORT_ORDERS }]
                    ]
                }
            });
        }

        if (text === KB.FINANCE) {
            return bot.sendMessage(currentChatId, '💰 <b>Финансы</b>\nВыберите:', {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: 'Баланс кассы и счетов', callback_data: CB.FIN_BALANCE }]]
                }
            });
        }

        if (text === KB.WAREHOUSE) {
            return bot.sendMessage(currentChatId, '🏗 <b>Склад</b>\nВыберите:', {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: 'Остатки цемента', callback_data: CB.WH_CEMENT }]]
                }
            });
        }

        if (text === KB.REFRESH) {
            return bot.sendMessage(currentChatId, '✅ Данные на экране обновлены. Меню без изменений.', {
                reply_markup: mainReplyKeyboard()
            });
        }

        if (text === LEGACY.BALANCE || text === '/balance') {
            try {
                const reply = await buildBalanceMessage(pool);
                return bot.sendMessage(currentChatId, reply, { parse_mode: 'HTML' });
            } catch (e) {
                logger.warn(`[TG] balance: ${e.message || e}`);
                return bot.sendMessage(currentChatId, '❌ Ошибка БД');
            }
        }

        if (text === LEGACY.CEMENT) {
            try {
                const reply = await buildCementMessage(pool);
                return bot.sendMessage(currentChatId, reply, { parse_mode: 'HTML' });
            } catch (e) {
                logger.warn(`[TG] cement: ${e.message || e}`);
                return bot.sendMessage(currentChatId, '❌ Ошибка');
            }
        }

        if (text === LEGACY.SALES_TODAY) {
            try {
                const reply = await buildSalesTodayMessage(pool);
                return bot.sendMessage(currentChatId, reply, { parse_mode: 'HTML' });
            } catch (e) {
                logger.warn(`[TG] sales today: ${e.message || e}`);
                return bot.sendMessage(currentChatId, '❌ Ошибка');
            }
        }

        return bot.sendMessage(currentChatId, 'ℹ️ Неизвестная команда. Откройте главное меню:', {
            reply_markup: mainReplyKeyboard()
        });
    });

    bot.on('callback_query', async (cq) => {
        const chatId = cq.message?.chat?.id;
        if (chatId == null || !authorizedChat(chatId)) return;

        const data = cq.data || '';
        const qid = cq.id;

        const map = {
            [CB.REPORT_SALES]: () => buildSalesTodayMessage(pool),
            [CB.REPORT_CEMENT]: () => buildCementMessage(pool),
            [CB.REPORT_ORDERS]: () => buildOrdersInWorkMessage(pool),
            [CB.FIN_BALANCE]: () => buildBalanceMessage(pool),
            [CB.WH_CEMENT]: () => buildCementMessage(pool)
        };

        const builder = map[data];
        if (!builder) {
            await safeAnswerCallback(qid);
            return;
        }

        try {
            const reply = await builder();
            await bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
            await safeAnswerCallback(qid);
        } catch (e) {
            logger.warn(`[TG] callback ${data}: ${e.message || e}`);
            await safeAnswerCallback(qid, { text: 'Ошибка', show_alert: false });
            try {
                await bot.sendMessage(chatId, '❌ Ошибка при получении данных');
            } catch (_) { /* ignore */ }
        }
    });
};
