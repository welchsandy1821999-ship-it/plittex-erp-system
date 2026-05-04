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
    if (tabId === 'admin-tab-users') adminLoadUsers();
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
    adminConfirmAndRun({
        title: '🧹 Подтвердите запуск',
        message: 'Запустить VACUUM ANALYZE? Операция может занять некоторое время.',
        run: async () => {
            const btn = document.getElementById('btn-vacuum');
            if (!btn) return;
            const original = btn.textContent;
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
                btn.textContent = original || 'Запустить VACUUM';
            }
        }
    });
}

function adminConfirmAndRun({ title, message, run }) {
    const actionKey = `__adminConfirmAction_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    window[actionKey] = async function () {
        try {
            UI.closeModal();
            await run();
        } finally {
            try { delete window[actionKey]; } catch (_) { /* ignore */ }
        }
    };
    const safeTitle = title || 'Подтверждение действия';
    const safeMessage = message || 'Выполнить действие?';
    UI.showModal(
        safeTitle,
        `<div class="font-13">${safeMessage}</div>`,
        `<button class="btn btn-outline" onclick="UI.closeModal(); try { delete window['${actionKey}']; } catch(e){}">Отмена</button><button class="btn btn-blue" onclick="${actionKey}()">Запустить</button>`
    );
}

async function adminRunServiceAction({ endpoint, buttonId, pendingText, doneTextBuilder, payload }) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = pendingText;
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {})
        });
        const data = await res.json();
        if (!res.ok || data.success === false) {
            throw new Error(data.error || 'Операция завершилась с ошибкой');
        }
        UI.toast(doneTextBuilder(data), 'success');
    } catch (err) {
        UI.toast(err.message || 'Ошибка выполнения сервисной операции', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

function adminAskReasonAndRun({ title, placeholder, onConfirm }) {
    UI.showModal(title, `
        <div class="form-group m-0">
            <label>Причина запуска (обязательно)</label>
            <textarea id="admin-service-reason" class="input-modern" rows="3" placeholder="${escapeHTML(placeholder || 'Например: плановая нормализация данных')}"></textarea>
        </div>
    `, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="adminConfirmServiceReason()">Запустить</button>
    `);
    window.__adminServiceReasonConfirm = async function() {
        const reason = (document.getElementById('admin-service-reason')?.value || '').trim();
        if (!reason) return UI.toast('Укажите причину запуска операции', 'warning');
        UI.closeModal();
        await onConfirm(reason);
    };
}

window.adminConfirmServiceReason = function() {
    if (typeof window.__adminServiceReasonConfirm === 'function') {
        window.__adminServiceReasonConfirm();
    }
};

async function adminReclassifyTransferWild() {
    adminConfirmAndRun({
        title: '🧭 Переклассификация переводов',
        message: 'Запустить сервисную переклассификацию статей по переводам?',
        run: async () => adminAskReasonAndRun({
            title: 'Причина переклассификации переводов',
            placeholder: 'Например: плановая нормализация переводов после импорта',
            onConfirm: async (reason) => adminRunServiceAction({
                endpoint: '/api/finance/reclassify-transfer-wild',
                buttonId: 'btn-reclassify-transfer',
                pendingText: '⏳ Выполняется...',
                doneTextBuilder: (data) => `Переклассификация переводов: обновлено ${Number(data.updated || 0)}`,
                payload: { reason }
            })
        })
    });
}

async function adminReclassifyTechnicalWild() {
    adminConfirmAndRun({
        title: '🧰 Переклассификация техопераций',
        message: 'Запустить сервисную переклассификацию технических операций?',
        run: async () => adminAskReasonAndRun({
            title: 'Причина переклассификации техопераций',
            placeholder: 'Например: плановая очистка технических проводок',
            onConfirm: async (reason) => adminRunServiceAction({
                endpoint: '/api/finance/reclassify-technical-wild',
                buttonId: 'btn-reclassify-technical',
                pendingText: '⏳ Выполняется...',
                doneTextBuilder: (data) => {
                    const scanned = Number(data.scanned || 0);
                    const updated = Number(data.updated || 0);
                    return `Техоперации: проверено ${scanned}, обновлено ${updated}`;
                },
                payload: { reason }
            })
        })
    });
}

async function adminAuditIncomeCategories() {
    const btn = document.getElementById('btn-audit-income');
    const resultEl = document.getElementById('admin-income-audit-result');
    if (!btn || !resultEl) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Проверка...';
    try {
        const res = await fetch('/api/finance/audit-income-categories');
        const data = await res.json();
        if (!res.ok || data.success === false) throw new Error(data.error || 'Ошибка аудита');
        const list = Array.isArray(data.problematic) ? data.problematic : [];
        const expected = Array.isArray(data.expected_system) ? data.expected_system : [];
        if (list.length === 0) {
            resultEl.textContent = 'Аудит завершен: конфликтов направления не найдено.';
            UI.toast('Аудит доходов: конфликтов не найдено', 'success');
        } else {
            const preview = list
                .slice(0, 8)
                .map((x) => `${x.category} (${x.cnt})`)
                .join(', ');
            resultEl.textContent = `Найдено проблемных статей: ${list.length}. Топ: ${preview}. Системных допустимых расхождений: ${expected.length}.`;
            UI.toast(`Аудит доходов: проблемных статей ${list.length}`, 'warning');
        }
    } catch (err) {
        UI.toast(err.message || 'Ошибка аудита доходных статей', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

async function adminReclassifyIncomeSuspicious() {
    adminConfirmAndRun({
        title: '🟢 Нормализация доходов',
        message: 'Запустить нормализацию проблемных доходных статей?',
        run: async () => adminAskReasonAndRun({
            title: 'Причина нормализации доходов',
            placeholder: 'Например: устранение конфликтных доходных категорий',
            onConfirm: async (reason) => adminRunServiceAction({
                endpoint: '/api/finance/reclassify-income-suspicious',
                buttonId: 'btn-fix-income',
                pendingText: '⏳ Нормализация...',
                doneTextBuilder: (data) => {
                    const scanned = Number(data.scanned || 0);
                    const updated = Number(data.updated || 0);
                    return `Доходы: проверено ${scanned}, обновлено ${updated}`;
                },
                payload: { reason }
            })
        })
            .then(() => adminAuditIncomeCategories())
    });
}

async function adminAuditExpenseCategories() {
    const btn = document.getElementById('btn-audit-expense');
    const resultEl = document.getElementById('admin-expense-audit-result');
    if (!btn || !resultEl) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Проверка...';
    try {
        const res = await fetch('/api/finance/audit-expense-categories');
        const data = await res.json();
        if (!res.ok || data.success === false) throw new Error(data.error || 'Ошибка аудита');
        const problematic = Array.isArray(data.problematic) ? data.problematic : [];
        const expected = Array.isArray(data.expected_system) ? data.expected_system : [];
        const wild = Array.isArray(data.wild) ? data.wild : [];
        if (problematic.length === 0 && wild.length === 0) {
            resultEl.textContent = `Аудит завершен: проблемных и диких расходных статей нет. Системных допустимых расхождений: ${expected.length}.`;
            UI.toast('Аудит расходов: проблем не найдено', 'success');
        } else {
            const pPreview = problematic.slice(0, 6).map((x) => `${x.category} (${x.cnt})`).join(', ');
            const wPreview = wild.slice(0, 6).map((x) => `${x.category} (${x.cnt})`).join(', ');
            resultEl.textContent = `Проблемные: ${problematic.length}${pPreview ? `. Топ: ${pPreview}` : ''}. Дикие: ${wild.length}${wPreview ? `. Топ: ${wPreview}` : ''}. Системные допустимые: ${expected.length}.`;
            UI.toast(`Аудит расходов: проблемных ${problematic.length}, диких ${wild.length}`, 'warning');
        }
    } catch (err) {
        UI.toast(err.message || 'Ошибка аудита расходных статей', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

async function adminReclassifyExpenseSuspicious() {
    adminConfirmAndRun({
        title: '🔴 Нормализация расходов',
        message: 'Запустить нормализацию проблемных расходных статей?',
        run: async () => adminAskReasonAndRun({
            title: 'Причина нормализации расходов',
            placeholder: 'Например: устранение конфликтных расходных категорий',
            onConfirm: async (reason) => adminRunServiceAction({
                endpoint: '/api/finance/reclassify-expense-suspicious',
                buttonId: 'btn-fix-expense',
                pendingText: '⏳ Нормализация...',
                doneTextBuilder: (data) => {
                    const scanned = Number(data.scanned || 0);
                    const updated = Number(data.updated || 0);
                    return `Расходы: проверено ${scanned}, обновлено ${updated}`;
                },
                payload: { reason }
            })
        })
            .then(() => adminAuditExpenseCategories())
    });
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
// 8. ПОЛЬЗОВАТЕЛИ (админ CRUD + soft deactivate)
// ═══════════════════════════════════════════════════
window.__adminUsersCache = [];

const ADMIN_ROLE_OPTIONS = [
    ['admin', 'Администратор'],
    ['manager', 'Менеджер'],
    ['accountant', 'Бухгалтер'],
    ['finance', 'Финансы'],
    ['buh', 'Бух. (краткий код)'],
    ['bukh', 'Бухгалтерия']
];

function adminRoleSelectHtml(selected) {
    const s = String(selected || '').toLowerCase();
    return ADMIN_ROLE_OPTIONS.map(([val, lab]) =>
        `<option value="${escapeHTML(val)}" ${val === s ? 'selected' : ''}>${escapeHTML(lab)}</option>`
    ).join('');
}

async function adminLoadUsers() {
    const body = document.getElementById('admin-users-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Загрузка...</td></tr>';
    try {
        const res = await fetch('/api/admin/users');
        const data = await res.json();
        if (!data.success) {
            body.innerHTML = `<tr><td colspan="6" class="text-center text-danger">${escapeHTML(data.error || 'Ошибка')}</td></tr>`;
            return;
        }
        window.__adminUsersCache = data.users || [];
        const selfId = typeof window.USER_ID !== 'undefined' ? window.USER_ID : null;
        if (!window.__adminUsersCache.length) {
            body.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Пользователей нет</td></tr>';
            return;
        }
        body.innerHTML = window.__adminUsersCache.map((u) => {
            const active = u.is_active !== false;
            const statusBadge = active
                ? '<span class="text-success font-bold">Активен</span>'
                : '<span class="text-danger font-bold">Заблокирован</span>';
            const toggleLabel = active ? '🔒 Заблокировать' : '✅ Активировать';
            const disableSelf = selfId != null && Number(u.id) === Number(selfId);
            const toggleDisabled = disableSelf ? 'disabled title="Нельзя изменить свой статус"' : '';
            return `<tr data-user-id="${u.id}">
                <td>${escapeHTML(String(u.id))}</td>
                <td><strong>${escapeHTML(u.username)}</strong></td>
                <td>${escapeHTML(u.full_name || '—')}</td>
                <td><code>${escapeHTML(u.role || '')}</code></td>
                <td>${statusBadge}</td>
                <td>
                    <button type="button" class="btn btn-outline btn-sm" onclick="adminOpenUserModal(${u.id})">✏️ Редактировать</button>
                    <button type="button" class="btn btn-warning btn-sm" onclick="adminToggleUser(${u.id})" ${toggleDisabled}>${toggleLabel}</button>
                </td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('Users load error:', err);
        body.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Ошибка сети</td></tr>';
    }
}

/** Пароль 8–10 символов: латиница обоих регистров + цифры. После генерации поле показывается как text для копирования. */
function adminGenerateUserPassword() {
    const pwdInput = document.getElementById('adm-user-password');
    const hintEl = document.getElementById('adm-user-password-hint');
    if (!pwdInput) return;

    const LOWER = 'abcdefghijklmnopqrstuvwxyz';
    const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const DIGIT = '23456789';
    const POOL = LOWER + UPPER + DIGIT;
    const len = 8 + Math.floor(Math.random() * 3);

    const chars = [
        LOWER[Math.floor(Math.random() * LOWER.length)],
        UPPER[Math.floor(Math.random() * UPPER.length)],
        DIGIT[Math.floor(Math.random() * DIGIT.length)]
    ];
    while (chars.length < len) {
        chars.push(POOL[Math.floor(Math.random() * POOL.length)]);
    }
    for (let i = chars.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = chars[i];
        chars[i] = chars[j];
        chars[j] = t;
    }

    pwdInput.value = chars.join('');
    pwdInput.type = 'text';
    if (hintEl) {
        hintEl.textContent =
            'Пароль показан открыто — скопируйте для передачи сотруднику.';
        hintEl.classList.remove('d-none');
    }
    adminUpdateCredentialShareUi();
}

/** Текст для передачи сотруднику через мессенджеры (до encodeURIComponent во внешних ссылках). */
function adminBuildCredentialShareBody() {
    const username = document.getElementById('adm-user-username')?.value?.trim() || '';
    const passwordRaw = document.getElementById('adm-user-password')?.value ?? '';
    const passwordTrim = passwordRaw.trim();
    const fullName = document.getElementById('adm-user-fullname')?.value?.trim() || '';
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const idRaw = document.getElementById('adm-user-id')?.value?.trim();
    const edit = !!idRaw;
    const passwordLine = passwordTrim
        ? passwordTrim
        : edit
          ? 'без изменений / сохранён ранее'
          : '';
    const fioLine = fullName ? `Сотрудник: ${fullName}` : 'Сотрудник: —';
    return `🔐 Доступ к ERP Плиттекс
${fioLine}
Логин: ${username}
Пароль: ${passwordLine}
Ссылка: ${origin}`;
}

/** Режим создания: нужны логин и пароль. Режим редактирования: достаточно логина (пароль может быть пустым). */
function adminCredentialShareReady() {
    const u = document.getElementById('adm-user-username')?.value?.trim();
    if (!u) return false;
    const edit = !!document.getElementById('adm-user-id')?.value?.trim();
    if (edit) return true;
    return !!document.getElementById('adm-user-password')?.value?.trim();
}

function adminUpdateCredentialShareUi() {
    const wrap = document.getElementById('adm-credential-share-wrap');
    if (!wrap) return;
    wrap.classList.toggle('d-none', !adminCredentialShareReady());
}

function adminBindCredentialShareHandlers() {
    ['adm-user-username', 'adm-user-password', 'adm-user-fullname'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', adminUpdateCredentialShareUi);
    });
    adminUpdateCredentialShareUi();
}

function adminShareCredentialsWhatsApp() {
    if (!adminCredentialShareReady()) return;
    const text = adminBuildCredentialShareBody();
    const href = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(href, '_blank', 'noopener,noreferrer');
}

function adminShareCredentialsTelegram() {
    if (!adminCredentialShareReady()) return;
    const text = adminBuildCredentialShareBody();
    const url = typeof window !== 'undefined' ? window.location.origin : '';
    const href = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
    window.open(href, '_blank', 'noopener,noreferrer');
}

function adminOpenUserModal(userId) {
    const edit = userId != null && userId !== '';
    const row = edit ? window.__adminUsersCache.find((x) => Number(x.id) === Number(userId)) : null;
    if (edit && !row) return UI.toast('Пользователь не найден в кэше. Обновите список.', 'warning');

    const title = edit ? `✏️ Редактировать: ${escapeHTML(row.username)}` : '➕ Новый пользователь';
    const idVal = edit ? row.id : '';
    const uname = edit ? row.username : '';
    const fname = edit ? (row.full_name || '') : '';
    const role = edit ? row.role : 'manager';

    UI.showModal(
        title,
        `<div class="form-group"><label class="font-12">Логин *</label>
            <input type="text" class="input-field" id="adm-user-username" value="${escapeHTML(uname)}" autocomplete="username"></div>
        <div class="form-group"><label class="font-12">ФИО</label>
            <input type="text" class="input-field" id="adm-user-fullname" value="${escapeHTML(fname)}" autocomplete="name"></div>
        <div class="form-group"><label class="font-12">Роль *</label>
            <select class="input-field" id="adm-user-role">${adminRoleSelectHtml(role)}</select></div>
        <div class="form-group m-0">
            <label class="font-12">${edit ? 'Пароль (пусто = не менять)' : 'Пароль *'}</label>
            <div style="display:flex; gap:10px; align-items:stretch; flex-wrap:wrap;">
                <input type="password" class="input-field" style="flex:1; min-width:180px;" id="adm-user-password" placeholder="${edit ? '•••••••• (скрыт)' : 'Введите пароль'}" autocomplete="new-password">
                <button type="button" class="btn btn-outline" style="white-space:nowrap;" onclick="adminGenerateUserPassword()" title="Случайный пароль">🎲 Сгенерировать</button>
            </div>
            <p id="adm-user-password-hint" class="font-11 text-muted m-0 mt-5 d-none"></p>
        </div>
        <div id="adm-credential-share-wrap" class="admin-credential-share d-none">
            <div class="admin-credential-share-title">Поделиться доступами</div>
            <div class="admin-credential-share-btns">
                <button type="button" class="btn btn-sm btn-admin-share-wa" onclick="adminShareCredentialsWhatsApp()" title="Открыть WhatsApp">WhatsApp</button>
                <button type="button" class="btn btn-sm btn-admin-share-tg" onclick="adminShareCredentialsTelegram()" title="Поделиться в Telegram">Telegram</button>
            </div>
        </div>
        <input type="hidden" id="adm-user-id" value="${escapeHTML(String(idVal))}">
        `,
        `<button type="button" class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
         <button type="button" class="btn btn-primary" onclick="adminSaveUser()">${edit ? 'Сохранить' : 'Создать'}</button>`
    );
    adminBindCredentialShareHandlers();
}

async function adminSaveUser() {
    const idRaw = document.getElementById('adm-user-id')?.value?.trim();
    const username = document.getElementById('adm-user-username')?.value?.trim();
    const full_name = document.getElementById('adm-user-fullname')?.value?.trim() || '';
    const role = document.getElementById('adm-user-role')?.value?.trim();
    const password = document.getElementById('adm-user-password')?.value || '';
    const edit = !!idRaw;

    if (!username) return UI.toast('Укажите логин', 'warning');
    if (!edit && (!password || password.length < 6)) return UI.toast('Пароль не менее 6 символов', 'warning');
    if (edit && password.trim() !== '' && password.trim().length < 6) {
        return UI.toast('Пароль не менее 6 символов или оставьте пустым', 'warning');
    }

    const payload = { username, full_name, role };
    if (!edit || password.trim() !== '') payload.password = password;

    try {
        const url = edit ? `/api/admin/users/${encodeURIComponent(idRaw)}` : '/api/admin/users';
        const res = await fetch(url, {
            method: edit ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        const oldRow = edit ? window.__adminUsersCache.find((x) => Number(x.id) === Number(idRaw)) : null;
        if (edit && oldRow && data.user && oldRow.username !== data.user.username) {
            UI.toast('Логин изменён: выйдите и войдите снова, чтобы отображался новый логин.', 'info');
        }
        UI.closeModal();
        UI.toast(edit ? 'Пользователь обновлён' : 'Пользователь создан', 'success');
        adminLoadUsers();
    } catch (e) {
        UI.toast(e.message || 'Ошибка сохранения', 'error');
    }
}

async function adminToggleUser(uid) {
    try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(uid)}/toggle-status`, { method: 'PUT' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        UI.toast('Статус обновлён', 'success');
        adminLoadUsers();
    } catch (e) {
        UI.toast(e.message || 'Ошибка', 'error');
    }
}

// ═══════════════════════════════════════════════════
// Инициализация при переключении на модуль
// ═══════════════════════════════════════════════════
function initAdmin() {
    adminLoadBackups();
}
