const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    // Маршруты-исключения: только логин
    if (req.path === '/login' || req.path === '/api/login') {
        return next();
    }

    // Ищем токен: сначала в заголовке Authorization (Bearer), затем в query-параметрах
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];
    
    // Если в заголовках токена нет, проверяем GET-параметр ?token= 
    // (актуально для /print/* и /files, открываемых в новой вкладке)
    if (!token && req.query && req.query.token) {
        token = req.query.token;
    }

    if (!token) return res.status(401).json({ error: 'Нет доступа. Токен отсутствует.' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(401).json({ error: 'Токен недействителен или истек срок действия.' });
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
