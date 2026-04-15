require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function run() {
    try {
        const cp = await pool.query(`SELECT * FROM counterparties WHERE name ILIKE '%Швецов%' LIMIT 1`);
        if(cp.rows.length === 0){
            console.log("No Shvetsov found.");
            return process.exit(0);
        }
        console.log(cp.rows[0]);
        process.exit(0);
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
}
run();
