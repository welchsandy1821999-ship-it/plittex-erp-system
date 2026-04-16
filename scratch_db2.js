const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', database: 'plittex_erp' });

pool.query("SELECT id, status, total_amount, paid_amount, pending_debt FROM client_orders WHERE counterparty_id=195")
    .then(r => {
        console.log('Orders:', r.rows);
        return pool.query("SELECT id, transaction_type, amount FROM transactions WHERE counterparty_id=195 AND COALESCE(is_deleted, false) = false");
    })
    .then(r => {
        console.log('Transactions:', r.rows);
        pool.end();
    });
