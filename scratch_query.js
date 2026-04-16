const { Client } = require('pg');
const c = new Client({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });
c.connect().then(() => {
    return c.query(`
        INSERT INTO inventory_movements (item_id, warehouse_id, movement_date, quantity, movement_type, description)
        VALUES (157, 1, '2026-03-01 10:00:00', 25000.00, 'initial_balance', 'Введено вручную (начальный остаток)')
    `);
}).then(res => {
    console.log('Record inserted successfully.');
    process.exit(0);
}).catch(e => {
    console.error(e);
    process.exit(1);
});
