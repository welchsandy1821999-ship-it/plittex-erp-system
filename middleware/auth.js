const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    // Маршруты-исключения: только логин
    if (req.path === '/login' || req.path === '/api/login') {
        return next();
    }

    // Ищем токен: сначала в заголовке Authorization (Bearer), затем в query token=
    // Токен в query разрешён только с type: 'print' (см. POST /api/generate-print-token)
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];
    let fromQuery = false;
    if (!token && req.query && req.query.token) {
        token = req.query.token;
        fromQuery = true;
    }

    if (!token) return res.status(401).json({ error: 'Нет доступа. Токен отсутствует.' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(401).json({ error: 'Токен недействителен или истек срок действия.' });
        if (fromQuery && user.type !== 'print') {
            return res.status(401).json({ error: 'Для печати используйте одноразовый print-токен' });
        }
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    // Ждем, что req.user уже заполнен через authenticateToken
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: '⛔ Доступ запрещен. Требуются права Администратора.' });
    }
};

module.exports = {
    authenticateToken,
    requireAdmin
};
