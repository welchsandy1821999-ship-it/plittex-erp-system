const fetch = require('node-fetch');

async function testLogin() {
    try {
        const response = await fetch('http://localhost:3000/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin' })
        });
        const status = response.status;
        const data = await response.json();
        console.log('--- LOGIN TEST ---');
        console.log('Status:', status);
        console.log('Data:', data);
    } catch (err) {
        console.error('Fetch error:', err.message);
    }
}

testLogin();
