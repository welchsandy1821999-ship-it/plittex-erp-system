/**
 * ERP Cache Manager (PATCH 36: Performance Optimization)
 * 🚀 Реализация системы кэширования справочников на фронтенде.
 */
(function() {
    const DEFAULT_TTL = 5 * 60 * 1000; // 5 минут в миллисекундах

    const CacheManager = {
        _store: new Map(),

        /**
         * Сохранить данные в кэш
         * @param {string} key - Ключ (например, URL API)
         * @param {any} data - Данные для сохранения
         * @param {number} ttl - Время жизни в мс (по умолчанию 5 мин)
         */
        set(key, data, ttl = DEFAULT_TTL) {
            if (!key) return;
            this._store.set(key, {
                data: JSON.parse(JSON.stringify(data)), // Deep copy to prevent accidental mutations
                expiry: Date.now() + ttl
            });
            // console.debug(`[Cache] Set: ${key} (TTL: ${ttl/1000}s)`);
        },

        /**
         * Получить данные из кэша
         * @param {string} key - Ключ
         * @returns {any|null} - Данные или null если просрочено/нет в кэше
         */
        get(key) {
            const entry = this._store.get(key);
            if (!entry) return null;

            if (Date.now() > entry.expiry) {
                // console.debug(`[Cache] Expired: ${key}`);
                this._store.delete(key);
                return null;
            }

            // console.debug(`[Cache] Hit: ${key}`);
            return JSON.parse(JSON.stringify(entry.data)); // Return a copy
        },

        /**
         * Удалить конкретный ключ или очистить всё
         * @param {string|null} key - Ключ или null для полной очистки
         */
        invalidate(key = null) {
            if (key) {
                this._store.delete(key);
                // console.debug(`[Cache] Partition invalidated: ${key}`);
            } else {
                this._store.clear();
                // console.debug(`[Cache] Full cache cleared`);
            }
        },

        /**
         * Алиас для удобной работы с API (Fetch-or-Cache)
         */
        async fetch(key, fetchFn, ttl = DEFAULT_TTL) {
            const cached = this.get(key);
            if (cached) return cached;

            const data = await fetchFn();
            if (data !== null && data !== undefined) {
                this.set(key, data, ttl);
            }
            return data;
        }
    };

    // Глобальный экспорт
    window.CacheManager = CacheManager;
    console.info('🚀 CacheManager initialized and ready.');
})();
