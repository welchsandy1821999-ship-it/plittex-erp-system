// Middleware для ограничения количества запросов к API (Защита от DDoS/флуда)
// Ослабленный лимит для обычной работы + исключения для безопасных batch-операций.

const logger = require('../utils/logger');
const rateLimit = new Map();
const LIMIT = 300;
const WINDOW_MS = 60000; // 1 минута

function normalizedPathname(req) {
    const raw = typeof req.originalUrl === 'string' ? req.originalUrl : typeof req.url === 'string' ? req.url : '';
    return raw.split('?')[0] || '';
}

// Исключения: не учитываем в лимит 300/мин (JWT всё равно обязателен через /api).
// Важно: при app.use('/api', ...) req.path может быть и с префиксом /api, и без него —
// надёжно смотреть normalizedPathname.
function isBypassedRoute(req) {
    const p = normalizedPathname(req);
    const method = req.method;

    if (method === 'POST' && (p.includes('/api/recipes/batch') || p.includes('/api/recipes/sync-category'))) {
        return true;
    }

    // Fallback UI сравнения: сотни GET /api/recipes/:id за минуту — легитимно, не DDoS
    if (method === 'GET' && /^\/api\/recipes\/[1-9]\d*$/.test(p)) {
        return true;
    }

    return false;
}

// Очистка старых IP адресов каждые 60 секунд, чтобы не забивать память
setInterval(() => {
    const now = Date.now();
    for (let [ip, record] of rateLimit.entries()) {
        if (now > record.resetTime) {
            rateLimit.delete(ip);
        }
    }
}, WINDOW_MS);

module.exports = function apiRateLimiter(req, res, next) {
    if (isBypassedRoute(req)) return next();

    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!rateLimit.has(ip)) {
        rateLimit.set(ip, { count: 1, resetTime: now + WINDOW_MS });
        return next();
    }
    
    const record = rateLimit.get(ip);
    if (now > record.resetTime) {
        record.count = 1;
        record.resetTime = now + WINDOW_MS;
        return next();
    }
    
    record.count++;
    if (record.count > LIMIT) {
        logger.warn(`[RATE LIMIT] Blocked IP: ${ip}`);
        return res.status(429).json({ error: 'Слишком много запросов. Пожалуйста, подождите минуту (Защита от флуда).' });
    }
    
    next();
};
