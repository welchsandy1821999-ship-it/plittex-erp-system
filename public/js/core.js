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
    }
};

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
                throw new Error(errBody.error || `HTTP ${res.status}`);
            }
            return await res.json();
        } catch (error) {
            console.error('[API GET Error]', error);
            if (typeof UI !== 'undefined' && UI.toast) UI.toast(error.message || 'Ошибка сети', 'error');
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
                throw new Error(errBody.error || `HTTP ${res.status}`);
            }
            return await res.json();
        } catch (error) {
            console.error('[API POST Error]', error);
            if (typeof UI !== 'undefined' && UI.toast) UI.toast(error.message || 'Ошибка сети', 'error');
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
                throw new Error(errBody.error || `HTTP ${res.status}`);
            }
            return await res.json();
        } catch (error) {
            console.error('[API PUT Error]', error);
            if (typeof UI !== 'undefined' && UI.toast) UI.toast(error.message || 'Ошибка сети', 'error');
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
                throw new Error(errBody.error || `HTTP ${res.status}`);
            }
            return await res.json();
        } catch (error) {
            console.error('[API PATCH Error]', error);
            if (typeof UI !== 'undefined' && UI.toast) UI.toast(error.message || 'Ошибка сети', 'error');
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
                throw new Error(errBody.error || `HTTP ${res.status}`);
            }
            const text = await res.text();
            return text ? JSON.parse(text) : true;
        } catch (error) {
            console.error('[API DELETE Error]', error);
            if (typeof UI !== 'undefined' && UI.toast) UI.toast(error.message || 'Ошибка сети', 'error');
            throw error;
        }
    }
};
