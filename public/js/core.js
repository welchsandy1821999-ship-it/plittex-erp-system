window.Utils = {
    escapeHtml: function(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    },
    formatMoney: function(sum) {
        if (isNaN(parseFloat(sum))) return '0 ₽';
        return parseFloat(sum).toLocaleString('ru-RU') + ' ₽';
    },
    formatDate: function(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    },
    /**
     * Валидация номера телефона.
     * Пустая строка = ок (телефон необязателен).
     * Если заполнен — после удаления всех нецифровых символов должно быть 10–15 цифр.
     * Принимает форматы: +7 (999) 123-45-67, 89991234567, +49 30 12345678 и т.д.
     * @param {string} phone
     * @returns {boolean}
     */
    isValidPhone: function(phone) {
        if (!phone || String(phone).trim() === '') return true;
        const digits = String(phone).replace(/\D/g, '');
        return digits.length >= 10 && digits.length <= 15;
    }
};

// Глобальный авто-форматер для номеров телефонов
document.addEventListener('input', function(e) {
    if (e.target.tagName === 'INPUT' && (e.target.type === 'tel' || e.target.id.toLowerCase().includes('phone') || e.target.name.toLowerCase().includes('phone'))) {
        let val = e.target.value;
        const onlyNumbers = val.replace(/\D/g, '');
        
        // Если поле очистили
        if (!onlyNumbers) {
            e.target.value = '';
            return;
        }

        // Автоматическая коррекция старта номера по Российскому стандарту
        if (['7', '8', '9'].includes(onlyNumbers[0])) {
            let num = onlyNumbers;
            if (num[0] === '8') num = '7' + num.substring(1);
            if (num[0] === '9') num = '7' + num;
            
            let formatted = '+7';
            if (num.length > 1) formatted += ' (' + num.substring(1, 4);
            if (num.length >= 5) formatted += ') ' + num.substring(4, 7);
            if (num.length >= 8) formatted += '-' + num.substring(7, 9);
            if (num.length >= 10) formatted += '-' + num.substring(9, 11);
            
            // Запоминаем позицию курсора до изменения чтобы не перепрыгивало в конец при редактировании
            e.target.value = formatted;
        } else {
            // Для остальных (иностранных) номеров
            e.target.value = '+' + onlyNumbers.substring(0, 15);
        }
    }
});

// Геттер токена — поддерживает два ключа (token и jwtToken) для совместимости
function _getAuthToken() {
    return localStorage.getItem('token') || localStorage.getItem('jwtToken') || '';
}

window.API = {
    get: async function(url) {
        try {
            const token = _getAuthToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = 'Bearer ' + token;
            const res = await fetch(url, { headers });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    if (typeof window.handleLogout === 'function') window.handleLogout();
                }
                const errBody = await res.json().catch(() => ({}));
const err = new Error(errBody.error || errBody.warning || `HTTP ${res.status}`);
err.body = errBody;
throw err;
            }
            return await res.json();
        } catch (error) {
            console.error('[API GET Error]', error);
            if (typeof UI !== 'undefined' && UI.toast && !error.body?.warning) UI.toast(error.message || 'Ошибка сети', 'error');
            throw error;
        }
    },
    post: async function(url, data) {
        try {
            const token = _getAuthToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = 'Bearer ' + token;
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(data)
            });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    if (typeof window.handleLogout === 'function') window.handleLogout();
                }
                const errBody = await res.json().catch(() => ({}));
const err = new Error(errBody.error || errBody.warning || `HTTP ${res.status}`);
err.body = errBody;
err.details = errBody.details || null;
throw err;
            }
            return await res.json();
        } catch (error) {
            console.error('[API POST Error]', error);
            if (typeof UI !== 'undefined' && UI.toast && !error.body?.warning) UI.toast(error.message || 'Ошибка сети', 'error');
            throw error;
        }
    },
    put: async function(url, data) {
        try {
            const token = _getAuthToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = 'Bearer ' + token;
            const res = await fetch(url, {
                method: 'PUT',
                headers,
                body: JSON.stringify(data)
            });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    if (typeof window.handleLogout === 'function') window.handleLogout();
                }
                const errBody = await res.json().catch(() => ({}));
const err = new Error(errBody.error || errBody.warning || `HTTP ${res.status}`);
err.body = errBody;
err.details = errBody.details || null;
throw err;
            }
            return await res.json();
        } catch (error) {
            console.error('[API PUT Error]', error);
            if (typeof UI !== 'undefined' && UI.toast && !error.body?.warning) UI.toast(error.message || 'Ошибка сети', 'error');
            throw error;
        }
    },
    patch: async function(url, data) {
        try {
            const token = _getAuthToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = 'Bearer ' + token;
            const res = await fetch(url, {
                method: 'PATCH',
                headers,
                body: JSON.stringify(data)
            });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    if (typeof window.handleLogout === 'function') window.handleLogout();
                }
                const errBody = await res.json().catch(() => ({}));
const err = new Error(errBody.error || errBody.warning || `HTTP ${res.status}`);
err.body = errBody;
throw err;
            }
            return await res.json();
        } catch (error) {
            console.error('[API PATCH Error]', error);
            if (typeof UI !== 'undefined' && UI.toast && !error.body?.warning) UI.toast(error.message || 'Ошибка сети', 'error');
            throw error;
        }
    },
    delete: async function(url) {
        try {
            const token = _getAuthToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = 'Bearer ' + token;
            const res = await fetch(url, { method: 'DELETE', headers });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    if (typeof window.handleLogout === 'function') window.handleLogout();
                }
                const errBody = await res.json().catch(() => ({}));
const err = new Error(errBody.error || errBody.warning || `HTTP ${res.status}`);
err.body = errBody;
throw err;
            }
            const text = await res.text();
            return text ? JSON.parse(text) : true;
        } catch (error) {
            console.error('[API DELETE Error]', error);
            if (typeof UI !== 'undefined' && UI.toast && !error.body?.warning) UI.toast(error.message || 'Ошибка сети', 'error');
            throw error;
        }
    }
};

// =========================================================
// [WebSocket Live Updates — Живая ERP]
// =========================================================
(function () {
    if (typeof io === 'undefined') return; // socket.io не подключен

    const t = (typeof _getAuthToken === 'function' && _getAuthToken()) || '';
    if (!t) {
        console.warn('WebSocket: нет JWT — real-time обновления отключены');
        return;
    }
    const socket = io({ auth: { token: t } });
    socket.on('connect_error', (e) => {
        console.warn('WebSocket connect_error:', e && e.message);
    });
    let debounceTimers = {};

    // Дебаунс: предотвращает множественные перезагрузки при пачке событий
    function debouncedRefresh(eventName, callback, delay) {
        if (debounceTimers[eventName]) clearTimeout(debounceTimers[eventName]);
        debounceTimers[eventName] = setTimeout(() => {
            console.log(`🔄 [WS] ${eventName} → обновление данных`);
            callback();
        }, delay || 500);
    }

    // --- Склад ---
    socket.on('inventory_updated', () => {
        debouncedRefresh('inventory', () => {
            if (typeof loadTable === 'function') loadTable();
            if (typeof loadDryingHistory === 'function' && document.getElementById('drying-history-block') && !document.getElementById('drying-history-block').classList.contains('d-none')) {
                loadDryingHistory();
            }
            if (typeof window.loadDashboardWidgets === 'function') window.loadDashboardWidgets();
        });
    });

    // --- Финансы ---
    socket.on('finance_updated', () => {
        debouncedRefresh('finance', () => {
            if (typeof loadFinanceData === 'function') loadFinanceData();
            if (typeof window.loadDashboardWidgets === 'function') window.loadDashboardWidgets();
        });
    });

    // --- Производство ---
    socket.on('production_updated', () => {
        debouncedRefresh('production', () => {
            if (typeof window.loadDailyHistory === 'function') window.loadDailyHistory();
            if (typeof window.updateCalendarMarks === 'function') window.updateCalendarMarks();
            if (typeof window.loadDashboardWidgets === 'function') window.loadDashboardWidgets();
        });
    });

    // --- Продажи ---
    socket.on('sales_updated', () => {
        debouncedRefresh('sales', () => {
            if (typeof initSales === 'function') initSales();
            if (typeof window.loadDashboardWidgets === 'function') window.loadDashboardWidgets();
        });
    });

    socket.on('connect', () => console.log('🔌 WebSocket подключен'));
    socket.on('disconnect', () => console.log('⚡ WebSocket отключен'));

    window._erpSocket = socket; // Экспорт для отладки
})();
