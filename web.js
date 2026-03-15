// ==========================================
// 1. ПОДКЛЮЧЕНИЕ БАЗОВЫХ МОДУЛЕЙ И СЕКРЕТОВ
// ==========================================
require('dotenv').config();

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

// Подключаем наши новые утилиты для Enterprise-версии
const logger = require('./utils/logger');
const { sendNotify } = require('./utils/telegram');

Big.RM = Big.roundHalfUp;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST,
    database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT
});

// Делаем WebSockets доступными во всех маршрутах
app.set('io', io);

// ==========================================
// 2. НАСТРОЙКИ СЕРВЕРА И ХРАНИЛИЩА (MULTER)
// ==========================================
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
const upload = multer({ storage: storage });

app.set('view engine', 'ejs');
app.set('views', './views');

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

// ==========================================
// 🛠️ ТВОИ ВРЕМЕННЫЕ МАРШРУТЫ СБРОСА (БЕЗ АВТОРИЗАЦИИ)
// ==========================================
app.get('/debug/reset-bank', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("DELETE FROM transactions WHERE payment_method = 'Безналичный расчет (Импорт)'");
        await client.query(`
            UPDATE accounts a
            SET balance = COALESCE((
                SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE -amount END)
                FROM transactions t 
                WHERE t.account_id = a.id
            ), 0)
        `);
        await client.query('COMMIT');
        res.send(`
            <div style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1 style="color: #4CAF50;">✅ База очищена!</h1>
                <p style="font-size: 18px;">Старые импорты удалены. Баланс пересчитан.</p>
                <b style="font-size: 20px;">Закройте вкладку и загрузите 4 файла заново.</b>
            </div>
        `);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send("Ошибка: " + err.message);
    } finally {
        client.release();
    }
});

app.get('/debug/upgrade-db', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false;');
        res.send('<h1 style="color:green; padding:50px;">✅ База обновлена: добавлена Корзина (is_deleted)!</h1>');
    } finally { client.release(); }
});

// ==========================================
// 3. ЯДРО: ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================
async function getNextDocNumber(client, prefix, table, column) {
    const seqMap = { 'ЗК': 'seq_doc_zk', 'СЧ': 'seq_doc_sch', 'УТ': 'seq_doc_ut' };
    const seqName = seqMap[prefix];
    if (!seqName) return `${prefix}-${new Date().getTime().toString().slice(-6)}`;
    const res = await client.query(`SELECT nextval('${seqName}') AS next_num`);
    return `${prefix}-${String(res.rows[0].next_num).padStart(5, '0')}`;
}

const warehouseCache = {};
async function getWhId(client, type) {
    if (warehouseCache[type]) return warehouseCache[type];
    const res = await client.query(`SELECT id FROM warehouses WHERE type = $1 LIMIT 1`, [type]);
    if (res.rows.length > 0) { warehouseCache[type] = res.rows[0].id; return warehouseCache[type]; }
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
        logger.error('❌ Ошибка транзакции, выполнен ROLLBACK: ' + err.message);
        throw err;
    } finally {
        client.release(); 
    }
}

// ==========================================
// 4. 🛡️ СИСТЕМА БЕЗОПАСНОСТИ: ПРОВЕРКА ТОКЕНА И РОЛЕЙ
// ==========================================
const authenticateToken = (req, res, next) => {
    // Пропускаем авторизацию, открытые маршруты печати и сохранение PDF
    if (req.path === '/login' || req.path === '/api/login' || req.path === '/api/docs/save-pdf' || req.path.startsWith('/print') || req.path.startsWith('/files')) {
        return next();
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 

    if (!token) return res.status(401).json({ error: 'Нет доступа. Токен отсутствует.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(401).json({ error: 'Токен просрочен или недействителен.' });
        req.user = user; 
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') next();
    else res.status(403).json({ error: '⛔ Доступ запрещен. Требуются права Администратора.' });
};

// ==========================================
// 5. БАЗОВЫЕ МАРШРУТЫ И АВТОРИЗАЦИЯ
// ==========================================
app.get('/', (req, res) => res.render('index'));

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Введите данные' });

    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Неверный логин' });

        const user = result.rows[0];
        let dbHash = (user.password_hash || "").trim();
        let incomingPassword = String(password).trim();

        // 🛡️ Твоя безопасная проверка с самолечением старых текстовых паролей
        let isValid = false;

        if (dbHash.startsWith('$2a$') || dbHash.startsWith('$2b$')) {
            isValid = await bcrypt.compare(incomingPassword, dbHash).catch(() => false);
        } else {
            if (dbHash === incomingPassword) {
                isValid = true;
                const newHash = await bcrypt.hash(incomingPassword, 10);
                await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
                logger.info(`🔒 Пароль пользователя ${username} успешно зашифрован (Самолечение).`);
            }
        }

        if (!isValid) return res.status(401).json({ error: 'Неверный логин или пароль' });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, user: { id: user.id, full_name: user.full_name, role: user.role } });
    } catch (err) {
        logger.error('Ошибка авторизации: ' + err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// Твой маршрут переименования счетов (Шестеренка)
app.put('/api/accounts/:id', async (req, res) => {
    const { name } = req.body;
    const accountId = req.params.id;
    const client = await pool.connect();

    try {
        await client.query('UPDATE accounts SET name = $1 WHERE id = $2', [name, accountId]);
        res.json({ success: true });
    } catch (err) {
        logger.error('Ошибка переименования счета: ' + err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// СИНХРОНИЗАЦИЯ БАЗЫ (Твое Самолечение таблиц)
pool.query(`
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, role VARCHAR(50) DEFAULT 'employee', full_name VARCHAR(150));
    INSERT INTO users (username, password_hash, role, full_name) VALUES ('admin', '12345', 'admin', 'Директор') ON CONFLICT (username) DO NOTHING;
`).catch(err => logger.error("Ошибка при инициализации БД: " + err.message));

// ==========================================
// 6. ИНИЦИАЛИЗАЦИЯ И ПОДКЛЮЧЕНИЕ РОУТЕРОВ
// ==========================================
const inventoryRoutes = require('./routes/inventory')(pool, getWhId, withTransaction);
const productionRoutes = require('./routes/production')(pool, getWhId, withTransaction);
const financeRoutes = require('./routes/finance')(pool, upload, withTransaction);
const dictionariesRoutes = require('./routes/dictionaries')(pool, withTransaction);
const hrRoutes = require('./routes/hr')(pool, withTransaction);
const salesRoutes = require('./routes/sales')(pool, getWhId, getNextDocNumber, withTransaction);
const docsRoutes = require('./routes/docs')(pool, getNextDocNumber, withTransaction);

// 🚨 СТРОГИЙ ПОРЯДОК ПРИМЕНЕНИЯ MIDDLEWARE

// Шаг 1: Сначала ставим глобальный вышибалу (проверка токена) для всех /api
app.use('/api', authenticateToken);

// Шаг 2: Усиливаем защиту для конкретных разделов (проверка роли Админа)
app.use('/api/finance', requireAdmin);
app.use('/api/salary', requireAdmin);

// Шаг 3: Подключаем обработчики
app.use('/', inventoryRoutes);
app.use('/', productionRoutes);
app.use('/', financeRoutes);
app.use('/', dictionariesRoutes);
app.use('/', hrRoutes);
app.use('/', salesRoutes);
app.use('/', docsRoutes); 

// ==========================================
// 7. ЗАПУСК И WEBSOCKETS
// ==========================================

io.on('connection', (socket) => {
    logger.info(`🔌 Новый клиент подключен к WebSockets: ${socket.id}`);
});

server.listen(port, () => {
    logger.info(`🚀 ERP Плиттекс Server запущен на порту ${port}`);
    sendNotify(`✅ <b>ERP Система запущена</b>\nСервер успешно стартовал и готов к работе.`);
});