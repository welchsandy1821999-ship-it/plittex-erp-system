const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST,
    database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT
});

const token = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });

const http = require('http');
const req = http.request({
    hostname: 'localhost', port: 3000, path: '/api/docs/registry', method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
}, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log("Status:", res.statusCode);
        console.log("Body:", data);
        process.exit(0);
    });
});
req.on('error', console.error);
req.end();
