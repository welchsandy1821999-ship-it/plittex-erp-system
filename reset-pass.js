require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER, 
    host: process.env.DB_HOST,
    database: process.env.DB_NAME, 
    password: process.env.DB_PASSWORD, 
    port: process.env.DB_PORT
});

async function reset() {
    try {
        const hash = '$2b$10$36Yk7PpI2Y283XhByXOlBec5/crM9fdCazvdLTS68u2od.8GiSZCS'; // 'admin'
        const res = await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [hash, 'admin']);
        console.log('✅ Password reset successful. Rows affected:', res.rowCount);
        process.exit(0);
    } catch (err) {
        console.error('❌ Reset FAILED:', err.message);
        process.exit(1);
    }
}

reset();
