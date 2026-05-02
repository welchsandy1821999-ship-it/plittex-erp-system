/**
 * utils/cache.js — Легковесный in-memory кэш с TTL и инвалидацией
 *
 * Используется для справочников, которые редко меняются:
 * transaction_categories, accounts, counterparties, warehouses, items, equipment.
 *
 * Инвалидация — через cache.invalidate(key) или cache.invalidatePrefix(prefix)
 * при мутирующих операциях (POST/PUT/DELETE).
 */

const logger = require('./logger');

const _store = new Map();

/**
 * Получить значение из кэша.
 * @param {string} key
 * @returns {*|null} данные или null, если TTL истёк / ключ отсутствует
 */
function get(key) {
    const entry = _store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        _store.delete(key);
        return null;
    }
    return entry.data;
}

/**
 * Записать значение в кэш.
 * @param {string} key
 * @param {*} data
 * @param {number} ttlMs — время жизни в миллисекундах (по умолчанию 60 сек)
 */
function set(key, data, ttlMs = 60000) {
    _store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/**
 * Удалить конкретный ключ.
 * @param {string} key
 */
function invalidate(key) {
    _store.delete(key);
}

/**
 * Удалить все ключи, начинающиеся с prefix.
 * Полезно для инвалидации группы: invalidatePrefix('counterparties') удалит
 * 'counterparties:list', 'counterparties:map' и т.д.
 * @param {string} prefix
 */
function invalidatePrefix(prefix) {
    for (const k of _store.keys()) {
        if (k.startsWith(prefix)) _store.delete(k);
    }
}

/**
 * Полная очистка кэша.
 */
function clear() {
    _store.clear();
}

/**
 * Текущий размер кэша (для мониторинга).
 */
function size() {
    return _store.size;
}

/**
 * «Кэширующая обёртка» — getOrSet.
 * Если ключ есть и не протух — возвращает из кэша.
 * Иначе — вызывает asyncFn(), кэширует результат и возвращает.
 *
 * @param {string} key
 * @param {Function} asyncFn — async () => data
 * @param {number} ttlMs
 * @returns {Promise<*>}
 */
async function getOrSet(key, asyncFn, ttlMs = 60000) {
    const cached = get(key);
    if (cached !== null) return cached;

    const data = await asyncFn();
    set(key, data, ttlMs);
    return data;
}

module.exports = { get, set, invalidate, invalidatePrefix, clear, size, getOrSet };
