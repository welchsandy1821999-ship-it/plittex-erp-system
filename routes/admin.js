/**
 * routes/admin.js — Центр Управления (Admin Hub)
 * 
 * API для системного администрирования ERP:
 * - Бэкапы и обслуживание БД
 * - Системная статистика (CPU, RAM, Disk)
 * - Чтение логов Winston
 * - Аудит действий
 * - Экспорт данных в CSV
 * - Глобальные настройки
 */
const express = require('express');
const router = express.Router();
const os = require('os');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { requireAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');
const { auditLog } = require('../utils/db_init');

const USER_ROLES = new Set(['admin', 'manager', 'accountant', 'finance', 'buh', 'bukh']);

// In-memory mutex: защита от параллельных VACUUM-запусков в одном Node.js процессе
let isVacuumRunning = false;

module.exports = function (pool) {
    // Все маршруты требуют роль admin
    router.use(requireAdmin);

    // ═══════════════════════════════════════════════════
    // 1. БЭКАПЫ
    // ═══════════════════════════════════════════════════

    /**
     * GET /api/admin/backups — Список файлов бэкапов
     */
    router.get('/backups', (req, res) => {
        const backupDir = path.join(__dirname, '..', 'backups');
        if (!fs.existsSync(backupDir)) {
            return res.json({ success: true, backups: [] });
        }

        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('erp-backup-') && (f.endsWith('.backup') || f.endsWith('.sql')))
            .map(f => {
                const stat = fs.statSync(path.join(backupDir, f));
                return {
                    name: f,
                    sizeKB: Math.round(stat.size / 1024),
                    createdAt: stat.mtime.toISOString()
                };
            })
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({ success: true, backups: files });
    });

    /**
     * POST /api/admin/backups/create — Ручной запуск бэкапа (дожидаться завершения pg_dump).
     */
    router.post('/backups/create', async (req, res) => {
        try {
            const { runBackup } = require('../utils/backup');
            const result = await runBackup();
            logger.info(`💾 [ADMIN] Ручной бэкап завершён пользователем ${req.user.username}: ${result.fileName}`);
            res.json({
                success: true,
                fileName: result.fileName,
                sizeKB: result.sizeKB,
                skipped: Boolean(result.skipped),
                message: result.skipped
                    ? `Бэкап за сегодня уже есть: ${result.fileName}`
                    : `Бэкап создан: ${result.fileName}`
            });
        } catch (err) {
            logger.error(`Ошибка бэкапа: ${err.message}`);
            res.status(500).json({ error: err.message || 'Не удалось создать бэкап' });
        }
    });

    /**
     * GET /api/admin/backups/download/:name — Скачивание дампа
     */
    router.get('/backups/download/:name', (req, res) => {
        const fileName = req.params.name;
        // Защита от path traversal и посторонних файлов в каталоге backups
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return res.status(400).json({ error: 'Недопустимое имя файла' });
        }
        if (!/^erp-backup-\d{4}-\d{2}-\d{2}\.(backup|sql)$/.test(fileName)) {
            return res.status(400).json({ error: 'Недопустимое имя файла' });
        }
        const filePath = path.join(__dirname, '..', 'backups', fileName);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Файл не найден' });
        }
        res.download(filePath, fileName);
    });

    // ═══════════════════════════════════════════════════
    // 2. СИСТЕМНАЯ СТАТИСТИКА
    // ═══════════════════════════════════════════════════

    /**
     * GET /api/admin/system/status — CPU, RAM, Uptime, DB
     */
    router.get('/system/status', async (req, res) => {
        try {
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            const cpus = os.cpus();
            const loadAvg = os.loadavg();

            // Проверка доступности БД
            let dbStatus = 'unavailable';
            let dbResponseMs = 0;
            let dbSize = 'N/A';
            let activeConnections = 0;
            try {
                const start = Date.now();
                await pool.query('SELECT 1');
                dbResponseMs = Date.now() - start;
                dbStatus = 'connected';

                const sizeRes = await pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
                dbSize = sizeRes.rows[0]?.size || 'N/A';

                const connRes = await pool.query(`SELECT count(*) AS cnt FROM pg_stat_activity WHERE datname = current_database()`);
                activeConnections = parseInt(connRes.rows[0]?.cnt || 0);
            } catch (e) { /* DB down */ }

            // Место на диске (корневой раздел)
            let diskInfo = { total: 0, free: 0, usedPercent: 0 };
            try {
                const backupDir = path.join(__dirname, '..', 'backups');
                if (fs.existsSync(backupDir)) {
                    const files = fs.readdirSync(backupDir).filter(
                        f =>
                            (f.startsWith('erp-backup-') && f.endsWith('.backup')) ||
                            (f.startsWith('erp-backup-') && f.endsWith('.sql'))
                    );
                    const totalSize = files.reduce((sum, f) => {
                        try { return sum + fs.statSync(path.join(backupDir, f)).size; } catch { return sum; }
                    }, 0);
                    diskInfo.backupsTotalKB = Math.round(totalSize / 1024);
                    diskInfo.backupsCount = files.length;
                }
            } catch (e) { /* ignore */ }

            res.json({
                success: true,
                system: {
                    hostname: os.hostname(),
                    platform: `${os.type()} ${os.release()}`,
                    nodeVersion: process.version,
                    uptime: Math.round(process.uptime()),
                    serverUptime: Math.round(os.uptime()),
                    cpuModel: cpus[0]?.model || 'N/A',
                    cpuCores: cpus.length,
                    loadAvg: loadAvg.map(v => v.toFixed(2)),
                    memory: {
                        totalMB: Math.round(totalMem / 1048576),
                        usedMB: Math.round(usedMem / 1048576),
                        freeMB: Math.round(freeMem / 1048576),
                        usedPercent: Math.round((usedMem / totalMem) * 100)
                    },
                    database: {
                        status: dbStatus,
                        responseMs: dbResponseMs,
                        size: dbSize,
                        activeConnections
                    },
                    backups: diskInfo
                }
            });
        } catch (err) {
            logger.error(`System status error: ${err.message}`);
            res.status(500).json({ error: 'Ошибка получения статуса системы' });
        }
    });

    // ═══════════════════════════════════════════════════
    // 3. ЛОГИ (Winston)
    // ═══════════════════════════════════════════════════

    /**
     * GET /api/admin/logs?lines=200 — Последние N строк лога
     */
    router.get('/logs', (req, res) => {
        try {
            const logsDir = path.join(__dirname, '..', 'logs');
            if (!fs.existsSync(logsDir)) {
                return res.json({ success: true, logs: [], file: 'N/A' });
            }

            // Находим самый свежий лог-файл
            const logFiles = fs.readdirSync(logsDir)
                .filter(f => f.startsWith('erp-') && f.endsWith('.log'))
                .sort()
                .reverse();

            if (logFiles.length === 0) {
                return res.json({ success: true, logs: [], file: 'N/A' });
            }

            const latestFile = logFiles[0];
            const filePath = path.join(logsDir, latestFile);
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            const maxLines = parseInt(req.query.lines) || 200;
            const tail = lines.slice(-maxLines);

            res.json({
                success: true,
                file: latestFile,
                totalLines: lines.length,
                showing: tail.length,
                logs: tail
            });
        } catch (err) {
            logger.error(`Logs read error: ${err.message}`);
            res.status(500).json({ error: 'Ошибка чтения логов' });
        }
    });

    // ═══════════════════════════════════════════════════
    // 4. АУДИТ
    // ═══════════════════════════════════════════════════

    /**
     * GET /api/admin/audit?limit=100&offset=0 — Лог аудита
     */
    router.get('/audit', async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 100, 500);
            const offset = parseInt(req.query.offset) || 0;

            const result = await pool.query(`
                SELECT id, user_id, username, action, entity, entity_id, details, ip_address, created_at
                FROM audit_logs
                ORDER BY created_at DESC
                LIMIT $1 OFFSET $2
            `, [limit, offset]);

            const countResult = await pool.query(`SELECT count(*) AS total FROM audit_logs`);

            res.json({
                success: true,
                total: parseInt(countResult.rows[0].total),
                logs: result.rows
            });
        } catch (err) {
            logger.error(`Audit read error: ${err.message}`);
            res.status(500).json({ error: 'Ошибка чтения аудита' });
        }
    });

    // ═══════════════════════════════════════════════════
    // 5. ЭКСПОРТ CSV
    // ═══════════════════════════════════════════════════

    const EXPORT_TABLES = {
        inventory_movements: {
            query: `SELECT im.id, i.name AS item_name, im.quantity, im.movement_type, im.description, 
                    w.name AS warehouse, im.movement_date, im.batch_id 
                    FROM inventory_movements im 
                    LEFT JOIN items i ON im.item_id = i.id 
                    LEFT JOIN warehouses w ON im.warehouse_id = w.id 
                    ORDER BY im.movement_date DESC LIMIT 10000`,
            label: 'Складские движения'
        },
        transactions: {
            query: `SELECT t.id, t.amount, t.transaction_type, t.category, t.description, t.method,
                    a.name AS account_name, t.transaction_date, t.created_at
                    FROM transactions t
                    LEFT JOIN accounts a ON t.account_id = a.id
                    ORDER BY t.transaction_date DESC LIMIT 10000`,
            label: 'Финансовые транзакции'
        },
        items: {
            query: `SELECT id, name, article, unit, category FROM items ORDER BY name`,
            label: 'Номенклатура'
        },
        counterparties: {
            query: `SELECT id, name, inn, phone, email, type, address FROM counterparties ORDER BY name`,
            label: 'Контрагенты'
        },
        employees: {
            query: `SELECT id, full_name, position, rate_per_day, phone, hire_date, is_active FROM employees ORDER BY full_name`,
            label: 'Сотрудники'
        }
    };

    /**
     * GET /api/admin/export/:table — Генерация CSV
     */
    router.get('/export/:table', async (req, res) => {
        const tableName = req.params.table;
        const config = EXPORT_TABLES[tableName];

        if (!config) {
            return res.status(400).json({
                error: `Таблица '${tableName}' не доступна для экспорта`,
                available: Object.keys(EXPORT_TABLES)
            });
        }

        try {
            const result = await pool.query(config.query);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Нет данных для экспорта' });
            }

            // Генерация CSV с BOM для нормального открытия в Excel
            const headers = Object.keys(result.rows[0]);
            const bom = '\uFEFF';
            let csv = bom + headers.join(';') + '\n';

            for (const row of result.rows) {
                const values = headers.map(h => {
                    const val = row[h];
                    if (val === null || val === undefined) return '';
                    const str = String(val).replace(/"/g, '""');
                    return str.includes(';') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
                });
                csv += values.join(';') + '\n';
            }

            const date = new Date().toISOString().split('T')[0];
            const fileName = `export-${tableName}-${date}.csv`;

            logger.info(`📊 [ADMIN] CSV-экспорт: ${config.label} (${result.rows.length} строк) — ${req.user.username}`);

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            res.send(csv);
        } catch (err) {
            logger.error(`CSV export error: ${err.message}`);
            res.status(500).json({ error: 'Ошибка экспорта' });
        }
    });

    // ═══════════════════════════════════════════════════
    // 6. НАСТРОЙКИ
    // ═══════════════════════════════════════════════════

    /**
     * GET /api/admin/settings — Все настройки
     */
    router.get('/settings', async (req, res) => {
        try {
            const result = await pool.query(`SELECT key, value, description FROM system_settings ORDER BY key`);
            res.json({ success: true, settings: result.rows });
        } catch (err) {
            logger.error(`Settings read error: ${err.message}`);
            res.status(500).json({ error: 'Ошибка чтения настроек' });
        }
    });

    /**
     * POST /api/admin/settings — Обновление настройки
     * Body: { key: "company_name", value: "ПЛИТТЕКС" }
     */
    router.post('/settings', async (req, res) => {
        const { key, value } = req.body;
        if (!key) return res.status(400).json({ error: 'Ключ настройки обязателен' });

        try {
            await pool.query(
                `INSERT INTO system_settings (key, value) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = $2`,
                [key, value]
            );
            logger.info(`⚙️ [ADMIN] Настройка "${key}" обновлена → "${value}" — ${req.user.username}`);
            res.json({ success: true, message: 'Настройка сохранена' });
        } catch (err) {
            logger.error(`Settings update error: ${err.message}`);
            res.status(500).json({ error: 'Ошибка сохранения' });
        }
    });

    // ═══════════════════════════════════════════════════
    // 7. ОБСЛУЖИВАНИЕ БД (Ручной VACUUM)
    // ═══════════════════════════════════════════════════

    /**
     * POST /api/admin/cron/vacuum — Ручной запуск VACUUM ANALYZE
     */
    router.post('/cron/vacuum', async (req, res) => {
        if (isVacuumRunning) {
            return res.status(409).json({
                success: false,
                error: 'Обслуживание БД уже выполняется. Дождитесь завершения текущего запуска.'
            });
        }

        isVacuumRunning = true;

        let client;
        const startedAt = new Date();
        const tables = [
            'inventory_movements',
            'transactions',
            'client_orders',
            'client_order_items',
            'production_batches',
            'invoices'
        ];
        const tableResults = [];
        try {
            client = await pool.connect();
            logger.info(`🧹 [ADMIN] Ручной VACUUM запущен — ${req.user.username}`);

            for (const table of tables) {
                const t0 = Date.now();
                try {
                    // VACUUM нельзя параметризовать как идентификатор через $1,
                    // поэтому используем whitelist из жёстко заданного массива tables.
                    await client.query(`VACUUM ANALYZE ${table}`);
                    tableResults.push({
                        table,
                        ok: true,
                        durationMs: Date.now() - t0
                    });
                } catch (e) {
                    tableResults.push({
                        table,
                        ok: false,
                        durationMs: Date.now() - t0,
                        error: e.message
                    });
                    throw e;
                }
            }

            const finishedAt = new Date();
            const durationMs = finishedAt.getTime() - startedAt.getTime();

            await auditLog(
                pool,
                req,
                'db_maintenance_vacuum',
                'system',
                null,
                `VACUUM ANALYZE: ok; tables=${tables.join(', ')}; durationMs=${durationMs}`
            );

            logger.info(`✅ [ADMIN] Ручной VACUUM завершён за ${durationMs}ms.`);
            res.json({
                success: true,
                message: 'VACUUM ANALYZE завершён успешно.',
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                durationMs,
                tables: tableResults
            });
        } catch (err) {
            const finishedAt = new Date();
            const durationMs = finishedAt.getTime() - startedAt.getTime();

            logger.error(`VACUUM error: ${err.message}`);

            try {
                await auditLog(
                    pool,
                    req,
                    'db_maintenance_vacuum',
                    'system',
                    null,
                    `VACUUM ANALYZE: error=${err.message}; processed=${tableResults.length}/${tables.length}; durationMs=${durationMs}`
                );
            } catch (e) {
                logger.error(`VACUUM auditLog error: ${e.message}`);
            }

            res.status(500).json({
                success: false,
                error: err.message,
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                durationMs,
                tables: tableResults
            });
        } finally {
            if (client) client.release();
            isVacuumRunning = false;
        }
    });

    // ═══════════════════════════════════════════════════
    // 8. ПОЛЬЗОВАТЕЛИ (CRUD без физического удаления)
    // ═══════════════════════════════════════════════════

    function normalizeRole(role) {
        const r = String(role || '').trim().toLowerCase();
        return USER_ROLES.has(r) ? r : null;
    }

    /** Сколько активных администраторов кроме excludeId */
    async function countOtherActiveAdmins(client, excludeId) {
        const r = await client.query(
            `SELECT COUNT(*)::int AS c FROM users
             WHERE role = 'admin' AND COALESCE(is_active, true) = true AND id <> $1`,
            [excludeId]
        );
        return r.rows[0]?.c ?? 0;
    }

    /**
     * GET /api/admin/users
     */
    router.get('/users', async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT id, username, full_name, role, COALESCE(is_active, true) AS is_active
                 FROM users
                 ORDER BY id ASC`
            );
            res.json({ success: true, users: result.rows });
        } catch (err) {
            logger.error(`Admin users list: ${err.message}`);
            res.status(500).json({ error: 'Ошибка чтения пользователей' });
        }
    });

    /**
     * POST /api/admin/users
     */
    router.post('/users', async (req, res) => {
        const { username, password, full_name, role } = req.body || {};
        const u = String(username || '').trim();
        const p = password != null ? String(password) : '';
        const fn = full_name != null ? String(full_name).trim() : '';
        const nr = normalizeRole(role);

        if (!u || u.length < 2) return res.status(400).json({ error: 'Логин слишком короткий' });
        if (p.length < 6) return res.status(400).json({ error: 'Пароль не менее 6 символов' });
        if (!nr) return res.status(400).json({ error: 'Недопустимая роль', allowed: [...USER_ROLES] });

        let client;
        try {
            client = await pool.connect();
            const exists = await client.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [u]);
            if (exists.rows.length) {
                return res.status(409).json({ error: 'Пользователь с таким логином уже есть' });
            }
            const hash = await bcrypt.hash(p, 10);
            const ins = await client.query(
                `INSERT INTO users (username, password_hash, full_name, role, is_active)
                 VALUES ($1, $2, $3, $4, true)
                 RETURNING id, username, full_name, role, is_active`,
                [u, hash, fn || null, nr]
            );
            const row = ins.rows[0];
            await auditLog(pool, req, 'create_user', 'user', row.id, `Создан пользователь ${row.username}, роль ${row.role}`);
            logger.info(`👤 [ADMIN] Создан пользователь ${row.username} — ${req.user.username}`);
            res.json({ success: true, user: row });
        } catch (err) {
            logger.error(`Admin create user: ${err.message}`);
            res.status(500).json({ error: 'Ошибка создания пользователя' });
        } finally {
            if (client) client.release();
        }
    });

    /**
     * PUT /api/admin/users/:id
     */
    router.put('/users/:id', async (req, res) => {
        const userId = parseInt(req.params.id, 10);
        if (!userId || userId < 1) return res.status(400).json({ error: 'Некорректный id' });

        const { username, password, full_name, role } = req.body || {};
        const u = username != null ? String(username).trim() : undefined;
        const fn = full_name !== undefined ? (full_name != null ? String(full_name).trim() : '') : undefined;
        const p = password !== undefined ? String(password) : undefined;
        const nr = role !== undefined ? normalizeRole(role) : undefined;

        if (nr === null && role !== undefined) {
            return res.status(400).json({ error: 'Недопустимая роль', allowed: [...USER_ROLES] });
        }

        let client;
        try {
            client = await pool.connect();

            const cur = await client.query(
                `SELECT id, username, role, COALESCE(is_active, true) AS is_active FROM users WHERE id = $1`,
                [userId]
            );
            if (!cur.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
            const before = cur.rows[0];

            if (nr != null && nr !== before.role && before.role === 'admin') {
                const others = await countOtherActiveAdmins(client, userId);
                if (others < 1) {
                    return res.status(400).json({ error: 'Нельзя сменить роль последнего активного администратора' });
                }
            }

            if (u != null && u.length < 2) return res.status(400).json({ error: 'Логин слишком короткий' });
            if (u != null) {
                const dup = await client.query(
                    'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2',
                    [u, userId]
                );
                if (dup.rows.length) return res.status(409).json({ error: 'Логин уже занят' });
            }

            const updates = [];
            const params = [];
            let n = 1;

            if (u != null) {
                updates.push(`username = $${n}`);
                params.push(u);
                n++;
            }
            if (fn !== undefined) {
                updates.push(`full_name = $${n}`);
                params.push(fn || null);
                n++;
            }
            if (nr != null) {
                updates.push(`role = $${n}`);
                params.push(nr);
                n++;
            }
            if (p !== undefined && p.trim() !== '') {
                if (p.length < 6) return res.status(400).json({ error: 'Пароль не менее 6 символов' });
                const hash = await bcrypt.hash(p.trim(), 10);
                updates.push(`password_hash = $${n}`);
                params.push(hash);
                n++;
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'Нет полей для обновления' });
            }

            params.push(userId);
            const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = $${n} RETURNING id, username, full_name, role, is_active`;
            const result = await client.query(sql, params);
            const row = result.rows[0];
            await auditLog(pool, req, 'update_user', 'user', userId, `Обновлён ${row.username}`);
            logger.info(`👤 [ADMIN] Обновлён пользователь id=${userId} — ${req.user.username}`);
            res.json({ success: true, user: row });
        } catch (err) {
            logger.error(`Admin update user: ${err.message}`);
            res.status(500).json({ error: 'Ошибка обновления пользователя' });
        } finally {
            if (client) client.release();
        }
    });

    /**
     * PUT /api/admin/users/:id/toggle-status
     */
    router.put('/users/:id/toggle-status', async (req, res) => {
        const userId = parseInt(req.params.id, 10);
        if (!userId || userId < 1) return res.status(400).json({ error: 'Некорректный id' });

        if (req.user.id === userId) {
            return res.status(400).json({ error: 'Нельзя отключить собственную учётную запись' });
        }

        let client;
        try {
            client = await pool.connect();
            const cur = await client.query(
                `SELECT id, username, role, COALESCE(is_active, true) AS is_active FROM users WHERE id = $1`,
                [userId]
            );
            if (!cur.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });

            const row = cur.rows[0];
            const nextActive = !row.is_active;

            if (row.role === 'admin' && row.is_active && !nextActive) {
                const others = await countOtherActiveAdmins(client, userId);
                if (others < 1) {
                    return res.status(400).json({ error: 'Нельзя отключить последнего активного администратора' });
                }
            }

            const upd = await client.query(
                `UPDATE users SET is_active = $1 WHERE id = $2
                 RETURNING id, username, full_name, role, is_active`,
                [nextActive, userId]
            );
            const out = upd.rows[0];
            await auditLog(
                pool,
                req,
                nextActive ? 'activate_user' : 'deactivate_user',
                'user',
                userId,
                `${out.username}: is_active=${nextActive}`
            );
            logger.info(`👤 [ADMIN] ${nextActive ? 'Активация' : 'Блокировка'} ${out.username} — ${req.user.username}`);
            res.json({ success: true, user: out });
        } catch (err) {
            logger.error(`Admin toggle user: ${err.message}`);
            res.status(500).json({ error: 'Ошибка смены статуса' });
        } finally {
            if (client) client.release();
        }
    });

    return router;
};
