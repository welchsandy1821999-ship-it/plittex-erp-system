// ==========================================
// 1. ПОДКЛЮЧЕНИЕ БАЗОВЫХ МОДУЛЕЙ И СЕКРЕТОВ
// ==========================================
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const Big = require('big.js');
const bcrypt = require('bcrypt');

Big.RM = Big.roundHalfUp;

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST,
    database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT
});

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
// 2. ЯДРО: ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
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

// ==========================================
// 3. БЕЗОПАСНОСТЬ И МАРШРУТЫ
// ==========================================
function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Нет доступа.' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Токен просрочен.' });
        req.user = user; next();
    });
}

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

        // 🛡️ ПАТЧ: Проверяем и как обычный текст (для дефолтного admin: 12345), и как сложный хэш
        const isValid = (dbHash === incomingPassword) || 
                        (await bcrypt.compare(incomingPassword, dbHash).catch(() => false));

        if (!isValid) return res.status(401).json({ error: 'Неверный логин или пароль' });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, user: { id: user.id, full_name: user.full_name, role: user.role } });
    } catch (err) { 
        console.error('Ошибка авторизации:', err);
        res.status(500).json({ error: 'Ошибка сервера' }); 
    } finally { 
        client.release(); 
    }
});
// Глобальный блокиратор /api
app.use('/api', (req, res, next) => {
    if (req.path === '/login') return next();
    authenticateToken(req, res, next);
});

// ==========================================
// 4. СИНХРОНИЗАЦИЯ БАЗЫ (Самолечение)
// ==========================================
pool.query(`
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, role VARCHAR(50) DEFAULT 'employee', full_name VARCHAR(150));
    INSERT INTO users (username, password_hash, role, full_name) VALUES ('admin', '12345', 'admin', 'Директор') ON CONFLICT (username) DO NOTHING;
`);

// ==========================================
// 5. ПОДКЛЮЧЕНИЕ РОУТЕРОВ (ЦЕХА БЭКЕНДА)
// ==========================================
const inventoryRoutes = require('./routes/inventory')(pool, getWhId);
const productionRoutes = require('./routes/production')(pool, getWhId);
const financeRoutes = require('./routes/finance')(pool, upload);
const dictionariesRoutes = require('./routes/dictionaries')(pool);
const hrRoutes = require('./routes/hr')(pool);
const salesRoutes = require('./routes/sales')(pool, getWhId, getNextDocNumber);
const docsRoutes = require('./routes/docs')(pool, getNextDocNumber);

app.use('/', inventoryRoutes);
app.use('/', productionRoutes);
app.use('/', financeRoutes);
app.use('/', dictionariesRoutes);
app.use('/', hrRoutes);
app.use('/', salesRoutes);
app.use('/', docsRoutes); // Доступ к /print открыт для браузера

app.listen(port, () => console.log(`🚀 ERP Плиттекс Server запущен: http://localhost:${port}`));