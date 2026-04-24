/**
 * public/js/admin.js — Клиентская логика Центра Управления
 */

// ═══════════════════════════════════════════════════
// Переключение вкладок
// ═══════════════════════════════════════════════════
function switchAdminTab(tabId, btn) {
    document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');
    if (btn) btn.classList.add('active');

    // Автозагрузка данных при переключении
    if (tabId === 'admin-tab-backups') adminLoadBackups();
    if (tabId === 'admin-tab-system') { adminLoadSystemStatus(); adminLoadLogs(); }
    if (tabId === 'admin-tab-audit') adminLoadAudit();
    if (tabId === 'admin-tab-settings') adminLoadSettings();
}

// ═══════════════════════════════════════════════════
// 1. БЭКАПЫ
// ═══════════════════════════════════════════════════
async function adminLoadBackups() {
    try {
        const res = await fetch('/api/admin/backups');
        const data = await res.json();
        const body = document.getElementById('admin-backups-body');
        if (!data.success || data.backups.length === 0) {
            body.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Бэкапов нет. Нажмите "Создать бэкап".</td></tr>';
            return;
        }
        body.innerHTML = data.backups.map(b => {
            const date = new Date(b.createdAt).toLocaleString('ru-RU');
            return `<tr>
                <td><strong>${escapeHTML(b.name)}</strong></td>
                <td>${b.sizeKB} KB</td>
                <td>${date}</td>
                <td><a href="#" class="btn btn-outline btn-sm" role="button" onclick="event.preventDefault(); void window.openPrintUrl('/api/admin/backups/download/${encodeURIComponent(b.name)}')">📥 Скачать</a></td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('Backups load error:', err);
    }
}

async function adminCreateBackup() {
    const btn = document.getElementById('btn-create-backup');
    btn.disabled = true;
    btn.textContent = '⏳ Создание...';
    try {
        const res = await fetch('/api/admin/backups/create', { method: 'POST' });
        const data = await res.json();
        UI.toast(data.message || 'Бэкап запущен', 'success');
        setTimeout(adminLoadBackups, 5000);
    } catch (err) {
        UI.toast('Ошибка создания бэкапа', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '➕ Создать бэкап';
    }
}

// ═══════════════════════════════════════════════════
// 2. VACUUM
// ═══════════════════════════════════════════════════
async function adminRunVacuum() {
    const btn = document.getElementById('btn-vacuum');
    if (!confirm('Запустить VACUUM ANALYZE? Это может занять несколько секунд.')) return;
    btn.disabled = true;
    btn.textContent = '⏳ Выполняется...';
    try {
        const res = await fetch('/api/admin/cron/vacuum', { method: 'POST' });
        const data = await res.json();
        UI.toast(data.message || 'VACUUM завершён', data.success ? 'success' : 'error');
    } catch (err) {
        UI.toast('Ошибка VACUUM', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Запустить VACUUM';
    }
}

// ═══════════════════════════════════════════════════
// 3. СИСТЕМНЫЙ СТАТУС
// ═══════════════════════════════════════════════════
async function adminLoadSystemStatus() {
    try {
        const res = await fetch('/api/admin/system/status');
        const data = await res.json();
        if (!data.success) return;
        const s = data.system;

        document.getElementById('metric-cpu').textContent = `${s.cpuCores} ядер`;
        document.getElementById('metric-ram').innerHTML = `${s.memory.usedMB} / ${s.memory.totalMB} MB <small>(${s.memory.usedPercent}%)</small>`;
        const ramBar = document.getElementById('bar-ram');
        if (ramBar) {
            ramBar.style.width = s.memory.usedPercent + '%';
            ramBar.className = 'admin-metric-fill' + (s.memory.usedPercent > 80 ? ' danger' : s.memory.usedPercent > 60 ? ' warning' : '');
        }

        const uptimeH = Math.floor(s.uptime / 3600);
        const uptimeM = Math.floor((s.uptime % 3600) / 60);
        document.getElementById('metric-uptime').textContent = `${uptimeH}ч ${uptimeM}м`;

        const dbEl = document.getElementById('metric-db');
        dbEl.textContent = s.database.status === 'connected' ? `✅ ${s.database.responseMs}ms` : '❌ Недоступна';
        dbEl.className = 'admin-metric-value ' + (s.database.status === 'connected' ? 'text-success' : 'text-danger');

        document.getElementById('metric-db-size').textContent = s.database.size;
        document.getElementById('metric-connections').textContent = s.database.activeConnections;
    } catch (err) {
        console.error('System status error:', err);
    }
}

// ═══════════════════════════════════════════════════
// 4. ЛОГИ
// ═══════════════════════════════════════════════════
async function adminLoadLogs() {
    try {
        const res = await fetch('/api/admin/logs?lines=200');
        const data = await res.json();
        document.getElementById('log-file-name').textContent = `📄 ${data.file}`;
        document.getElementById('log-line-count').textContent = `${data.showing} / ${data.totalLines} строк`;

        const content = document.getElementById('admin-log-content');
        if (data.logs && data.logs.length > 0) {
            content.textContent = data.logs.join('\n');
        } else {
            content.textContent = 'Лог-файл пуст.';
        }
        // Авто-скролл вниз
        const terminal = document.getElementById('admin-terminal');
        terminal.scrollTop = terminal.scrollHeight;
    } catch (err) {
        document.getElementById('admin-log-content').textContent = 'Ошибка загрузки логов: ' + err.message;
    }
}

// ═══════════════════════════════════════════════════
// 5. АУДИТ
// ═══════════════════════════════════════════════════
let auditPage = 0;
const AUDIT_PAGE_SIZE = 50;

async function adminLoadAudit(page) {
    if (page !== undefined) auditPage = page;
    const offset = auditPage * AUDIT_PAGE_SIZE;
    try {
        const res = await fetch(`/api/admin/audit?limit=${AUDIT_PAGE_SIZE}&offset=${offset}`);
        const data = await res.json();
        const body = document.getElementById('admin-audit-body');

        if (!data.success || data.logs.length === 0) {
            body.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Записей аудита нет.</td></tr>';
            document.getElementById('admin-audit-pagination').innerHTML = '';
            return;
        }

        body.innerHTML = data.logs.map(l => {
            const time = new Date(l.created_at).toLocaleString('ru-RU');
            return `<tr>
                <td>${time}</td>
                <td>${escapeHTML(l.username || '—')}</td>
                <td><span class="badge badge-${getActionBadge(l.action)}">${escapeHTML(l.action)}</span></td>
                <td>${escapeHTML(l.entity || '—')}</td>
                <td>${l.entity_id || '—'}</td>
                <td class="text-muted">${escapeHTML(l.details || '')}</td>
                <td class="text-muted">${escapeHTML(l.ip_address || '')}</td>
            </tr>`;
        }).join('');

        // Пагинация
        const totalPages = Math.ceil(data.total / AUDIT_PAGE_SIZE);
        let paginationHtml = '';
        if (totalPages > 1) {
            if (auditPage > 0) paginationHtml += `<button class="btn btn-outline btn-sm" onclick="adminLoadAudit(${auditPage - 1})">← Назад</button>`;
            paginationHtml += `<span class="text-muted">Стр. ${auditPage + 1} из ${totalPages} (${data.total} записей)</span>`;
            if (auditPage < totalPages - 1) paginationHtml += `<button class="btn btn-outline btn-sm" onclick="adminLoadAudit(${auditPage + 1})">Вперёд →</button>`;
        }
        document.getElementById('admin-audit-pagination').innerHTML = paginationHtml;
    } catch (err) {
        console.error('Audit load error:', err);
    }
}

function getActionBadge(action) {
    if (action.includes('delete')) return 'danger';
    if (action.includes('create') || action.includes('add')) return 'success';
    if (action.includes('update') || action.includes('edit')) return 'warning';
    return 'info';
}

// ═══════════════════════════════════════════════════
// 6. CSV ЭКСПОРТ
// ═══════════════════════════════════════════════════
function adminExport(table) {
    void window.openPrintUrl(`/api/admin/export/${table}`);
    UI.toast(`📊 Экспорт "${table}" начат`, 'success');
}

// ═══════════════════════════════════════════════════
// 7. НАСТРОЙКИ
// ═══════════════════════════════════════════════════
async function adminLoadSettings() {
    try {
        const res = await fetch('/api/admin/settings');
        const data = await res.json();
        const body = document.getElementById('admin-settings-body');

        if (!data.success || data.settings.length === 0) {
            body.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Настроек нет.</td></tr>';
            return;
        }

        body.innerHTML = data.settings.map(s => `<tr>
            <td><code>${escapeHTML(s.key)}</code></td>
            <td>
                <input type="text" class="input-field admin-setting-input" 
                       id="setting-${escapeHTML(s.key)}" value="${escapeHTML(s.value || '')}">
            </td>
            <td class="text-muted">${escapeHTML(s.description || '')}</td>
            <td>
                <button class="btn btn-primary btn-sm" onclick="adminSaveSetting('${escapeHTML(s.key)}')">💾</button>
            </td>
        </tr>`).join('');
    } catch (err) {
        console.error('Settings load error:', err);
    }
}

async function adminSaveSetting(key) {
    const input = document.getElementById(`setting-${key}`);
    if (!input) return;
    try {
        const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value: input.value })
        });
        const data = await res.json();
        UI.toast(data.message || 'Сохранено', data.success ? 'success' : 'error');
    } catch (err) {
        UI.toast('Ошибка сохранения', 'error');
    }
}

// ═══════════════════════════════════════════════════
// Инициализация при переключении на модуль
// ═══════════════════════════════════════════════════
function initAdmin() {
    adminLoadBackups();
}
