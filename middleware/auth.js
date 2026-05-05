const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

/**
 * ВРЕМЕННЫЙ РЕЖИМ: всем авторизованным пользователям даём права admin.
 * Отключение: FORCE_ALL_USERS_ADMIN=false в .env (и перезапуск сервера).
 */
function isForceAllUsersAdmin() {
    const raw = String(process.env.FORCE_ALL_USERS_ADMIN || 'true').trim().toLowerCase();
    return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

const authenticateToken = (req, res, next) => {
    // Маршруты-исключения: только логин
    if (req.path === '/login' || req.path === '/api/login') {
        return next();
    }

    // Ищем токен: 1) Authorization Bearer 2) query token= (GET/старые ссылки)
    // 3) поле print_token в теле (POST /print/… после urlencoded-парсера — надёжнее длинного JWT в URL).
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];
    /** Токен не из Bearer — должно быть JWT с payload.type === 'print' */
    let requirePrintJwt = false;

    if (!token) {
        let qTok = req.query && req.query.token;
        if (Array.isArray(qTok)) qTok = qTok[0];
        if (qTok) {
            token = qTok;
            requirePrintJwt = true;
        }
    }

    const canBodyPrint =
        !token &&
        req.method === 'POST' &&
        (req.path === '/print/kp' || req.path === '/print/blank_order_draft') &&
        req.body &&
        typeof req.body.print_token === 'string' &&
        req.body.print_token.trim() !== '';

    if (canBodyPrint) {
        token = req.body.print_token.trim();
        requirePrintJwt = true;
    }

    if (!token) return res.status(401).json({ error: 'Нет доступа. Токен отсутствует.' });

    const secret = process.env.JWT_SECRET;
    if (!secret) {
        logger.error('authenticateToken: JWT_SECRET не задан');
        return res.status(500).json({ error: 'Ошибка конфигурации сервера (JWT)' });
    }

    jwt.verify(token, secret, { clockTolerance: 60 }, (err, user) => {
        if (err) return res.status(401).json({ error: 'Токен недействителен или истек срок действия.' });
        if (requirePrintJwt && user.type !== 'print') {
            return res.status(401).json({ error: 'Для печати используйте одноразовый print-токен' });
        }
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    // Ждем, что req.user уже заполнен через authenticateToken
    if (req.user && (req.user.role === 'admin' || isForceAllUsersAdmin())) {
        next();
    } else {
        res.status(403).json({ error: '⛔ Доступ запрещен. Требуются права Администратора.' });
    }
};

/** Роли, которым с поля БД/флага в JWT доверяем ведение плана платежей (доп. к admin и can_planned) */
const PLANNED_PLAN_ROLES = new Set(['accountant', 'finance', 'buh', 'bukh']);

const requirePlannedPlanManage = (req, res, next) => {
    const u = req.user;
    if (!u) {
        return res.status(401).json({ error: 'Нет доступа' });
    }
    if (isForceAllUsersAdmin()) return next();
    if (u.role === 'admin' || u.can_planned === true) {
        return next();
    }
    if (u.role && PLANNED_PLAN_ROLES.has(String(u.role))) {
        return next();
    }
    return res.status(403).json({ error: 'Нет прав на создание/удаление плановых платежей. Обратитесь к администратору.' });
};

const REPORT_ACTIONS = new Set([
    'view',
    'export',
    'print',
    'manage_templates',
    'manage_shared_presets'
]);

const REPORT_DEFAULT_ROLE_MATRIX = {
    admin: new Set(['view', 'export', 'print', 'manage_templates', 'manage_shared_presets']),
    accountant: new Set(['view', 'export', 'print']),
    finance: new Set(['view', 'export', 'print']),
    buh: new Set(['view', 'export', 'print']),
    bukh: new Set(['view', 'export', 'print']),
    manager: new Set(['view'])
};

function hasReportPermission(user, action) {
    if (!user || !REPORT_ACTIONS.has(action)) return false;
    if (isForceAllUsersAdmin()) return true;
    if (String(user.role || '').toLowerCase() === 'admin') return true;

    // Explicit JWT flags have priority
    const flagName = `can_reports_${action}`;
    if (user[flagName] === true) return true;
    if (user[flagName] === false) return false;

    const role = String(user.role || '').toLowerCase();
    const allowedByRole = REPORT_DEFAULT_ROLE_MATRIX[role];
    return Boolean(allowedByRole && allowedByRole.has(action));
}

const requireReportAccess = (action) => (req, res, next) => {
    if (!REPORT_ACTIONS.has(action)) {
        return res.status(500).json({ error: 'Неверная конфигурация прав отчетов.' });
    }
    if (!req.user) return res.status(401).json({ error: 'Нет доступа' });
    if (!hasReportPermission(req.user, action)) {
        return res.status(403).json({ error: `Нет прав на действие reports:${action}.` });
    }
    return next();
};

module.exports = {
    authenticateToken,
    requireAdmin,
    requirePlannedPlanManage,
    PLANNED_PLAN_ROLES,
    hasReportPermission,
    requireReportAccess
};
