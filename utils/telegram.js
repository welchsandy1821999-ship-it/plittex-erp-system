const TelegramBot = require('node-telegram-bot-api');
const logger = require('./logger');
const { formatMskDateTime } = require('./mskTime');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot = null;

/** Снимок уведомления ERP (ключ chatId:messageId): исходный HTML и разметка для «⬅️ Назад». */
const notifyMessageSnapshots = new Map();
const SNAP_MAX = 200;

function stashNotifySnapshot(chatKey, messageKey, snapshot) {
    while (notifyMessageSnapshots.size >= SNAP_MAX) {
        const firstKey = notifyMessageSnapshots.keys().next().value;
        notifyMessageSnapshots.delete(firstKey);
    }
    notifyMessageSnapshots.set(`${chatKey}:${messageKey}`, snapshot);
}

function getNotifySnapshot(chatId, messageId) {
    return notifyMessageSnapshots.get(`${chatId}:${messageId}`);
}

/**
 * Колбэки из уведомлений ERP (общие действия после списания/заказа).
 */
const NOTIFY_CB = {
    STOCK_SUMMARY: 'tg:n:stk',
    ORDERS_OPEN: 'tg:n:ord',
    NOTIFY_BACK: 'tg:n:bk'
};

if (token) {
    const tgProxyRaw = process.env.TG_PROXY_URL != null ? String(process.env.TG_PROXY_URL).trim() : '';
    const tgProxyUrl = tgProxyRaw.length > 0 ? tgProxyRaw : null;

    const botOptions = {
        polling: {
            interval: 300,
            autoStart: true,
            params: { timeout: 10 }
        }
    };
    if (tgProxyUrl) {
        botOptions.request = { proxy: tgProxyUrl };
    }

    bot = new TelegramBot(token, botOptions);
    logger.info(
        `Telegram-бот запущен в интерактивном режиме (polling: interval=300ms, long-poll timeout=10s)${tgProxyUrl ? '; API через прокси (TG_PROXY_URL)' : ''}.`
    );

    bot.on('polling_error', (error) => {
        const errCode = error && error.code !== undefined ? error.code : '';
        const body = error && error.response && error.response.body ? error.response.body : null;
        const apiCode = body && typeof body.error_code === 'number' ? body.error_code : null;
        const description = body && body.description != null ? String(body.description) : '';
        const msgStr = `${error && error.message ? error.message : String(error)} ${description}`.trim();
        const isConflict =
            errCode === 'ETELEGRAM' &&
            (apiCode === 409 ||
                /\b409\b/.test(msgStr) ||
                /terminated by other getupdates request/i.test(msgStr));

        if (isConflict) {
            logger.error(
                'CRITICAL: [TG] КТО-ТО ЗАПУСТИЛ ДУБЛЬ БОТА! Конфликт getUpdates (409). Останавливаем polling.'
            );
            bot.stopPolling().catch((e) => logger.warn(`[TG] stopPolling: ${e.message || e}`));
            return;
        }

        const transientHint = ['ECONNRESET', 'ETIMEDOUT', 'EFATAL'].includes(errCode) ? ' (transient)' : '';
        logger.warn(`[TG] polling_error${transientHint} code=${errCode || 'n/a'} api=${apiCode != null ? apiCode : 'n/a'} ${msgStr}`);
    });

    bot.on('error', (error) => {
        logger.error(`🔴 [TG] error event: ${error && error.message ? error.message : String(error)}`, error);
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

/** Денежные суммы в Telegram: «1 250 000,50» (ru-RU). */
function formatMoney(val) {
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/\s/g, '').replace(',', '.'));
    if (Number.isNaN(n)) return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(0);
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

/**
 * Уведомление в единственный авторизованный чат ERP.
 * @param {string} message HTML-сообщение
 * @param {{ reply_markup?: object }} [options] — см. Telegram API (inline_keyboard и т.д.)
 * @returns {Promise<import('node-telegram-bot-api').TelegramBot.Message>|undefined}
 */
function sendNotify(message, options = {}) {
    if (!bot || !chatId) return undefined;

    const currentTime = formatMskDateTime(new Date());
    message = String(message ?? '') + '\n\n🕒 ' + currentTime;

    const payload = { parse_mode: 'HTML', ...options };
    return bot.sendMessage(chatId, message, payload)
        .then((sent) => {
            const snap = {
                text: message,
                reply_markup: payload.reply_markup || undefined
            };
            stashNotifySnapshot(sent.chat.id, sent.message_id, snap);
            return sent;
        })
        .catch((err) => {
            logger.warn(`ТГ отправка уведомления: ${err.message || err}`);
        });
}

/**
 * Уведомление об изменении взаиморасчётов контрагента (ДДС / корректировка / оплата).
 */
function notifyCounterpartyBalanceChange({
    counterpartyName,
    amount,
    transactionType,
    operationType,
    description,
    transactionDate,
    isReversal = false
}) {
    const amt = Math.abs(Number(amount) || 0);
    if (!counterpartyName || amt <= 0) return undefined;

    const isIncome = transactionType === 'income';
    const signedPositive = isReversal ? !isIncome : isIncome;
    const sign = signedPositive ? '+' : '−';
    const flowLabel = signedPositive ? 'Приход' : 'Расход';
    const when = transactionDate ? formatMskDateTime(transactionDate) : formatMskDateTime(new Date());

    let msg = `💰 <b>Баланс контрагента</b>\n`;
    msg += `📅 ${escapeHtml(when)}\n`;
    msg += `👤 ${escapeHtml(counterpartyName)}\n`;
    msg += `💵 ${flowLabel}: <b>${sign}${formatMoney(amt)}</b> ₽\n`;
    msg += `📋 ${escapeHtml(operationType || 'Операция')}`;
    if (description) msg += `\n📝 ${escapeHtml(description)}`;

    return sendNotify(msg);
}

module.exports = {
    sendNotify,
    notifyCounterpartyBalanceChange,
    bot,
    chatId,
    escapeHtml,
    formatMoney,
    NOTIFY_CB,
    getNotifySnapshot,
    formatMskDateTime
};
