const http = require('http');
const jwt = require('jsonwebtoken');

const token = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, 'Plittex_Super_Secret_Key_2026_CHANGE_ME_IN_PRODUCTION', { expiresIn: '1h' });

const payload = {
    productId: 433,
    productName: "Плитка \"Старый город\" 40мм",
    ingredients: [
        { materialId: 153, name: "Цемент М-600", qty: 100 },
        { materialId: 155, name: "Песок основной", qty: 200 }
    ],
    force: false
};

const req = http.request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/recipes/save',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
    }
}, res => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
        console.log(`STATUS: ${res.statusCode}`);
        console.log(`BODY: ${raw}`);
        
        // TEST MASS APPLY
        const payloadMass = {
            targetProductIds: [433, 434],
            materials: [
                { materialId: "153", qty: 100 },
                { materialId: "155", qty: 200 }
            ],
            force: false
        };
        const reqMass = http.request({
            hostname: 'localhost',
            port: 3000,
            path: '/api/recipes/sync-category',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            }
        }, res2 => {
            let raw2 = '';
            res2.on('data', chunk => raw2 += chunk);
            res2.on('end', () => {
                console.log(`MASS STATUS: ${res2.statusCode}`);
                console.log(`MASS BODY: ${raw2}`);
            });
        });
        reqMass.write(JSON.stringify(payloadMass));
        reqMass.end();
    });
});

req.write(JSON.stringify(payload));
req.end();
