// [Блок 1: Подключение модулей и конфигурация]
require('dotenv').config();
const logger = require('./utils/logger');

// [Блок 1.1: Sentry — Мониторинг ошибок (безопасная инициализация)]
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: 0.2, // 20% транзакций для мониторинга производительности
    });
    logger.info('✅ Sentry инициализирован.');
} else {
    logger.info('ℹ️  SENTRY_DSN не задан — мониторинг Sentry отключен.');
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const Big = require('big.js');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const { sendNotify, bot, chatId } = require('./utils/telegram');

Big.RM = Big.roundHalfUp;

const app = express();
const server = http.createServer(app);

/**
 * CORS: список origin из CORS_ORIGIN (через запятую). Пусто — только локальные URL.
 * Не используем "*": при credentials: true это некорректно.
 */
function getAllowedCorsOrigins() {
    const raw = process.env.CORS_ORIGIN;
    if (!raw || !String(raw).trim()) {
        return ['http://localhost:3000', 'http://127.0.0.1:3000'];
    }
    return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function corsAllowOriginCallback(origin, callback) {
    const allowlist = getAllowedCorsOrigins();
    if (!origin) {
        return callback(null, true);
    }
    if (allowlist.includes(origin)) {
        return callback(null, true);
    }
    logger.warn(`CORS: origin не разрешён: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
}

const io = new Server(server, {
    cors: {
        origin: corsAllowOriginCallback,
        methods: ['GET', 'POST'],
        credentials: true
    }
});

/**
 * Токен для Socket.io: auth.token, Authorization: Bearer, cookie token / access_token
 */
function extractSocketToken(socket) {
    const a = socket.handshake?.auth;
    if (a && a.token) {
        return String(a.token);
    }
    const hdr = socket.handshake?.headers?.authorization;
    if (hdr && String(hdr).startsWith('Bearer ')) {
        return String(hdr).slice(7).trim();
    }
    const cookie = socket.handshake?.headers?.cookie;
    if (cookie) {
        for (const part of String(cookie).split(';')) {
            const eq = part.indexOf('=');
            if (eq === -1) continue;
            const k = part.slice(0, eq).trim();
            const v = part.slice(eq + 1).trim();
            if (k === 'token' || k === 'access_token') {
                try {
                    return decodeURIComponent(v);
                } catch (e) {
                    return v;
                }
            }
        }
    }
    return null;
}

io.use((socket, next) => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        logger.error('Socket.io: JWT_SECRET не задан');
        return next(new Error('Authentication error'));
    }
    const token = extractSocketToken(socket);
    if (!token) {
        return next(new Error('Authentication error'));
    }
    jwt.verify(token, secret, (err) => {
        if (err) {
            return next(new Error('Authentication error'));
        }
        next();
    });
});

const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// [Блок 2: Настройка базы данных]
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    max: 20,                        // Максимум подключений в пуле
    idleTimeoutMillis: 30000,       // Закрывать idle через 30с
    connectionTimeoutMillis: 5000,  // Таймаут на подключение к БД
    statement_timeout: 30000        // Убивать запросы длиннее 30с
});

pool.on('error', (err) => {
    logger.error(`🚨 Непредвиденная ошибка в пуле соединений БД: ${err.message}`);
});

app.set('io', io);

// [Блок 2.2: Инициализация системных таблиц]
const { initSystemTables, auditLog } = require('./utils/db_init');
initSystemTables(pool);

// [Блок 3: Система загрузки файлов (Multer)]
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = './public/uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        cb(null, 'doc_' + Date.now() + '_' + Math.round(Math.random() * 1000) + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Недопустимый формат файла!'), false);
    }
};

const upload = multer({ storage: storage, fileFilter: fileFilter });

app.set('view engine', 'ejs');
app.set('views', './views');

// [Блок 2.1: Security & Performance Middleware]
app.use(helmet({
    contentSecurityPolicy: false // Отключаем CSP для inline-скриптов в EJS
}));
app.use(cors({
    origin: corsAllowOriginCallback,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true
}));
app.use(compression());

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

// Защита API от спама и DDoS
const apiRateLimiter = require('./middleware/rateLimit');
app.use('/api', apiRateLimiter);

// [Блок 4: Вспомогательные функции (Транзакции, Нумерация, Склады)]
async function getNextDocNumber(client, prefix, table, column) {
    let result = await client.query(`
        UPDATE document_counters SET last_number = last_number + 1 WHERE prefix = $1 RETURNING last_number
    `, [prefix]);

    if (result.rows.length === 0) {
        result = await client.query(`INSERT INTO document_counters (prefix, last_number) VALUES ($1, 1) RETURNING last_number`, [prefix]);
    }
    return `${prefix}-${String(result.rows[0].last_number).padStart(5, '0')}`;
}

const warehouseCache = {};
async function getWhId(client, type) {
    if (warehouseCache[type]) return warehouseCache[type];
    const res = await client.query(`SELECT id FROM warehouses WHERE type = $1 LIMIT 1`, [type]);
    if (res.rows.length > 0) {
        warehouseCache[type] = res.rows[0].id;
        return warehouseCache[type];
    }
    else throw new Error(`Склад '${type}' не найден!`);
}

async function withTransaction(pool, callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error('❌ Ошибка транзакции: ' + err.message);
        throw err;
    } finally {
        client.release();
    }
}

// [Блок 5: Безопасность и Авторизация]
const { authenticateToken } = require('./middleware/auth');

app.get('/', (req, res) => res.render('index', { devMode: process.env.DEV_MODE === 'true' }));

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    logger.info(`🔑 Попытка входа: ${username}`);

    if (!username || !password) return res.status(400).json({ error: 'Введите данные' });

    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT * FROM users WHERE username = $1', [username]);

        if (result.rows.length === 0) {
            logger.warn(`❌ Пользователь не найден: ${username}`);
            return res.status(401).json({ error: 'Неверный логин' });
        }

        const user = result.rows[0];
        let dbHash = (user.password_hash || "").trim();
        let incomingPassword = String(password).trim();
        let isValid = false;

        if (dbHash.startsWith('$2a$') || dbHash.startsWith('$2b$')) {
            isValid = await bcrypt.compare(incomingPassword, dbHash).catch(err => {
                logger.error('Bcrypt comparison error: ' + err.message);
                return false;
            });
        } else {
            if (dbHash === incomingPassword) {
                isValid = true;
                const newHash = await bcrypt.hash(incomingPassword, 10);
                await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
                logger.info(`🔒 Пароль пользователя ${username} зашифрован.`);
            }
        }

        if (!isValid) {
            logger.warn(`❌ Неверный пароль для: ${username}`);
            return res.status(401).json({ error: 'Неверный пароль' });
        }

        if (!JWT_SECRET) {
            logger.error('🚨 JWT_SECRET is missing!');
            return res.status(500).json({ error: 'Ошибка конфигурации сервера' });
        }

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
        logger.info(`✅ Успешный вход: ${username}`);
        res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
        logger.error(`💥 Ошибка API входа: ${err.message}`);
        res.status(500).json({ error: 'Ошибка сервера: ' + err.message });
    } finally {
        if (client) client.release();
    }
});

// [Блок 6: Финансовая конфигурация (ERP_CONFIG)]
const ERP_CONFIG = {
    vatRate: 22,
    vatDivider: 1.22,
    vatRatio: 122,
    noVatCategories: ['Зарплата', 'Налоги, штрафы и взносы', 'Услуги банка и РКО', 'Возврат займов', 'Получение займов', 'Взаимозачет']
};

// [Блок 7: Подключение маршрутов модулей]
const inventoryRoutes = require('./routes/inventory')(pool, getWhId, withTransaction);
const productionRoutes = require('./routes/production')(pool, getWhId, withTransaction);
const dictionariesRoutes = require('./routes/dictionaries')(pool, withTransaction);
const hrRoutes = require('./routes/hr')(pool, withTransaction);
const financeRoutes = require('./routes/finance')(pool, upload, withTransaction, ERP_CONFIG);
const salesRoutes = require('./routes/sales')(pool, getWhId, getNextDocNumber, withTransaction, ERP_CONFIG);
const docsRoutes = require('./routes/docs')(pool, ERP_CONFIG, withTransaction, getNextDocNumber);
const devRoutes = require('./routes/dev')(pool, withTransaction, logger);
const adminRoutes = require('./routes/admin')(pool);

// Защита API (Глобальная проверка токена JWT)
// Health-check идёт ДО JWT — доступен без авторизации (для Docker/мониторинга)
app.get('/api/health', async (req, res) => {
    const start = Date.now();
    try {
        await pool.query('SELECT 1');
        res.json({
            status: 'healthy',
            uptime: Math.round(process.uptime()),
            dbResponseMs: Date.now() - start,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(503).json({
            status: 'degraded',
            error: 'Database unavailable',
            timestamp: new Date().toISOString()
        });
    }
});
// Одноразовый print-токен (1 мин) для ?token= в ссылках печати; основной JWT — только в Authorization
app.post('/api/generate-print-token', authenticateToken, (req, res) => {
    if (!process.env.JWT_SECRET) {
        return res.status(500).json({ error: 'Ошибка конфигурации сервера' });
    }
    if (!req.user || req.user.id == null) {
        return res.status(401).json({ error: 'Пользователь не определён' });
    }
    if (req.user.type === 'print') {
        return res.status(400).json({ error: 'Нельзя выдавать print-токен по print-токену' });
    }
    const printToken = jwt.sign(
        { id: req.user.id, username: req.user.username, role: req.user.role, type: 'print' },
        process.env.JWT_SECRET,
        { expiresIn: '1m' }
    );
    return res.json({ printToken });
});

app.use('/api', authenticateToken);

// Регистрация маршрутов
app.use('/', inventoryRoutes);
app.use('/', productionRoutes);
app.use('/', financeRoutes);
app.use('/', dictionariesRoutes);
app.use('/', hrRoutes);
app.use('/', salesRoutes);
app.use('/', docsRoutes);
app.use('/api/dev', devRoutes);
app.use('/api/admin', adminRoutes);

// [Блок 7.5: Глобальный обработчик ошибок Express + Sentry]
if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}
app.use((err, req, res, next) => {
    logger.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// [Блок 8: Telegram Бот (Интеграция)]
if (bot) {
    bot.on('message', async (msg) => {
        const currentChatId = msg.chat.id;
        if (String(currentChatId) !== String(chatId)) return;

        const text = msg.text || '';
        if (text === '/start') {
            return bot.sendMessage(currentChatId, '👋 Выберите команду:', {
                reply_markup: { keyboard: [['💰 Баланс кассы', '📦 Остаток цемента'], ['📊 Отчет по продажам за сегодня']], resize_keyboard: true }
            });
        }

        if (text === '💰 Баланс кассы' || text === '/balance') {
            try {
                const res = await pool.query('SELECT name, balance FROM accounts ORDER BY id ASC');
                let reply = '<b>🏦 Баланс:</b>\n\n'; let total = 0;
                res.rows.forEach(acc => {
                    reply += `🔹 ${acc.name}: ${parseFloat(acc.balance).toLocaleString()} ₽\n`;
                    total += parseFloat(acc.balance);
                });
                reply += `\n<b>💵 ИТОГО: ${total.toLocaleString()} ₽</b>`;
                bot.sendMessage(currentChatId, reply, { parse_mode: 'HTML' });
            } catch (e) { bot.sendMessage(currentChatId, '❌ Ошибка БД'); }
        }

        if (text === '📦 Остаток цемента') {
            try {
                const res = await pool.query(`SELECT i.name, SUM(m.quantity) as total FROM inventory_movements m JOIN items i ON m.item_id = i.id WHERE i.name ILIKE '%цемент%' GROUP BY i.name`);
                if (res.rows.length === 0) return bot.sendMessage(currentChatId, '🏗 Не найден.');
                let reply = '<b>🏗 Остатки цемента:</b>\n\n';
                res.rows.forEach(r => reply += `• ${r.name}: ${parseFloat(r.total).toLocaleString()} кг\n`);
                bot.sendMessage(currentChatId, reply, { parse_mode: 'HTML' });
            } catch (e) { bot.sendMessage(currentChatId, '❌ Ошибка'); }
        }

        if (text === '📊 Отчет по продажам за сегодня') {
            try {
                const res = await pool.query(`SELECT SUM(total_amount) as total, COUNT(*) as cnt FROM client_orders WHERE created_at::date = CURRENT_DATE AND status != 'cancelled'`);
                bot.sendMessage(currentChatId, `📈 <b>Сегодня:</b>\n\nЗаказов: ${res.rows[0]?.cnt || 0}\nСумма: ${parseFloat(res.rows[0]?.total || 0).toLocaleString()} ₽`, { parse_mode: 'HTML' });
            } catch (e) { bot.sendMessage(currentChatId, '❌ Ошибка'); }
        }
    });
}

// [Блок 8.5: Фоновые задачи (Cron)]
const { initCronJobs } = require('./utils/cron');
initCronJobs(pool);

// [Блок 9: Socket.io и Старт сервера]
io.on('connection', (socket) => logger.info(`🔌 Подключен: ${socket.id}`));

server.listen(port, () => {
    logger.info(`🚀 ERP Server запущен на порту ${port}`);
    sendNotify(`✅ <b>Система запущена</b>\nСервер готов к работе.`);
});

// [Блок 10: Graceful Shutdown - корректное завершение]
const gracefulShutdown = () => {
    logger.info('🛑 Получен сигнал завершения. Освобождаем ресурсы...');
    server.close(() => {
        logger.info('📡 HTTP сервер остановлен.');
        pool.end(() => {
            logger.info('🐘 Пул соединений БД закрыт.');
            process.exit(0);
        });
    });
};

// Перехват сигналов остановки процесса
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);