require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER, 
    host: process.env.DB_HOST,
    database: process.env.DB_NAME, 
    password: process.env.DB_PASSWORD, 
    port: process.env.DB_PORT
});

async function test() {
    try {
        const res = await pool.query('SELECT current_user, current_database()');
        console.log('✅ Connection OK:', res.rows[0]);
        const users = await pool.query('SELECT count(*) FROM users');
        console.log('📊 Users count:', users.rows[0].count);
        process.exit(0);
    } catch (err) {
        console.error('❌ Connection FAILED:', err.message);
        process.exit(1);
    }
}

test();
