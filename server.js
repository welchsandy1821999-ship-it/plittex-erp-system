// 1. Подключаем библиотеку pg для работы с базой
const { Pool } = require('pg');

// 2. Создаем "пул" подключений (настройки доступа к БД)
const pool = new Pool({
    user: 'postgres',         // стандартный пользователь
    password: 'Plittex_2026_SQL',  // пароль, который ты придумал при установке
    host: 'localhost',        // база находится на этом же компьютере
    port: 5432,               // стандартный порт PostgreSQL
    database: 'plittex_erp'   // имя нашей базы данных
});

// 3. Проверяем подключение
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Ошибка подключения к базе:', err.message);
    } else {
        console.log('Ура! Успешное подключение к PostgreSQL!');
        console.log('Текущее время в базе:', res.rows[0].now);
    }
});