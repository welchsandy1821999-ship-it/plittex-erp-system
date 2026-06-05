/**
 * Безопасное построение URL API: без hardcoded host/port, совместимо с HTTPS reverse proxy.
 * Исправляет mixed content (https-страница → http API) и закладки на :3000 вне localhost.
 */
(function (global) {
    function isLocalDevHost(hostname) {
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    }

    function getRequestOrigin() {
        if (!global.location || !global.location.hostname) return '';
        const { hostname, protocol, port, origin } = global.location;
        if (isLocalDevHost(hostname)) return origin;
        // Прод: закладка http://domain:3000 — Node напрямую с мобильной сети недоступен.
        if (port === '3000' || port === '3001') {
            return `https://${hostname}`;
        }
        return origin;
    }

    function resolveApiUrl(path) {
        const raw = String(path || '').trim();
        if (!raw) return raw;

        if (/^https?:\/\//i.test(raw)) {
            try {
                const parsed = new URL(raw);
                if (global.location && global.location.protocol === 'https:' && parsed.protocol === 'http:') {
                    parsed.protocol = 'https:';
                }
                if (!isLocalDevHost(parsed.hostname) && (parsed.port === '3000' || parsed.port === '3001')) {
                    parsed.port = '';
                }
                return parsed.toString();
            } catch (e) {
                return raw;
            }
        }

        const rel = raw.startsWith('/') ? raw : `/${raw}`;
        const base = getRequestOrigin();
        return base ? `${base}${rel}` : rel;
    }

    global.resolveApiUrl = resolveApiUrl;
    global.getRequestOrigin = getRequestOrigin;
})(typeof window !== 'undefined' ? window : globalThis);
