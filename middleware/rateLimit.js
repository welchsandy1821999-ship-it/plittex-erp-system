// Middleware для ограничения количества запросов к API (Защита от DDoS/флуда)
// Лимит: 100 запросов в минуту с одного IP (AUDIT-017)

const rateLimit = new Map();
const LIMIT = 100;
const WINDOW_MS = 60000; // 1 минута

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
        console.warn(`[RATE LIMIT] Blocked IP: ${ip}`);
        return res.status(429).json({ error: 'Слишком много запросов. Пожалуйста, подождите минуту (Защита от флуда).' });
    }
    
    next();
};
