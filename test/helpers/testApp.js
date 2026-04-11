/**
 * Тестовый хелпер — создаёт изолированное Express-приложение с моками БД.
 * Все запросы к БД перехватываются, реальная PostgreSQL не затрагивается.
 */
const express = require('express');

/**
 * Создаёт мок пула PostgreSQL.
 * Ключевая идея: mockClient.query — единый jest.fn() для всех запросов.
 * pool.query и client.query — ОБА ведут к одному и тому же jest.fn().
 */
function createMockPool(queryHandler) {
    // Единая функция для query — позволяет менять поведение в каждом test()
    const sharedQueryFn = jest.fn(async (text, params) => {
        return { rows: [], rowCount: 0 };
    });

    // Устанавливаем default handler, если передан
    if (queryHandler && typeof queryHandler === 'object') {
        sharedQueryFn.mockImplementation(async (text, params) => {
            for (const [pattern, result] of Object.entries(queryHandler)) {
                if (text.includes(pattern)) {
                    return typeof result === 'function' ? result(text, params) : result;
                }
            }
            return { rows: [], rowCount: 0 };
        });
    }

    const mockClient = {
        query: sharedQueryFn,
        release: jest.fn()
    };

    const pool = {
        query: sharedQueryFn, // Одна и та же функция
        connect: jest.fn().mockResolvedValue(mockClient),
        end: jest.fn(),
        _client: mockClient,
        _queryFn: sharedQueryFn // Удобный алиас для тестов
    };

    return pool;
}

/**
 * Мок withTransaction — выполняет callback с mock-клиентом.
 * Не делает BEGIN/COMMIT — просто прокидывает client.
 */
function createMockWithTransaction(mockPool) {
    return async function withTransaction(pool, callback) {
        const client = mockPool._client; // Используем напрямую, без pool.connect()
        try {
            await callback(client);
        } catch (e) {
            throw e; // Пробрасываем ошибки
        }
    };
}

/**
 * Создаёт тестовое Express-приложение с подключенными роутами.
 * Обходит JWT аутентификацию, подставляя req.user.
 */
function createTestApp(routeFactory, factoryArgs) {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Мок Socket.io
    const mockIo = { emit: jest.fn() };
    app.set('io', mockIo);

    // Обходим глобальный authenticateToken
    app.use('/api', (req, res, next) => {
        req.user = { id: 1, username: 'test_admin', role: 'admin' };
        next();
    });

    const router = routeFactory(...factoryArgs);
    app.use('/', router);

    return { app, io: mockIo };
}

module.exports = {
    createMockPool,
    createMockWithTransaction,
    createTestApp
};
