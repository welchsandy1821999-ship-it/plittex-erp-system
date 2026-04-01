const { Client } = require('pg');
require('dotenv').config({ path: 'c:/Users/Пользователь/Desktop/plittex-erp/.env' });

async function testConnection(host) {
    console.log(`--- Testing connection to ${host}:${process.env.DB_PORT} ---`);
    const client = new Client({
        user: process.env.DB_USER,
        host: host,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
        connectionTimeoutMillis: 5000,
    });

    try {
        await client.connect();
        console.log(`SUCCESS: Connected to ${host}`);
        const res = await client.query('SELECT NOW() as now, current_database() as db');
        console.log('Query result:', res.rows[0]);
        await client.end();
        return true;
    } catch (err) {
        console.error(`FAILURE: Could not connect to ${host}`);
        console.error('Error Code:', err.code);
        console.error('Error Message:', err.message);
        return false;
    }
}

async function runTests() {
    const successLocal = await testConnection('localhost');
    console.log('\n');
    const successIP = await testConnection('127.0.0.1');

    if (!successLocal && !successIP) {
        process.exit(1);
    }
}

runTests();
