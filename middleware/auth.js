const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    // Маршруты-исключения
    if (req.path === '/login' || req.path === '/api/login' || req.originalUrl === '/api/docs/save-pdf' || req.path.startsWith('/print') || req.path.startsWith('/files')) {
        return next();
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

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
