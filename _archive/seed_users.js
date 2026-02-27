const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL', 
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

async function setupUsers() {
    console.log('Добавляем сотрудников в базу...');
    try {
        await pool.query(
            `INSERT INTO users (username, password, role, full_name) VALUES 
            ($1, $2, $3, $4),
            ($5, $6, $7, $8)`,
            [
                'director', 'boss123', 'admin', 'Иван (Директор)',
                'master', 'shop123', 'worker', 'Петр (Мастер цеха)'
            ]
        );
        console.log('✅ Сотрудники успешно наняты!');
    } catch (err) {
        console.error('❌ Ошибка:', err.message);
    } finally {
        pool.end();
    }
}

setupUsers();