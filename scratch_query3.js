const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:Plittex_2026_SQL@localhost:5432/plittex_erp' });
pool.query("SELECT counterparty_id FROM client_orders WHERE doc_number = 'ЗК-00026' LIMIT 1", (err, res) => {
    if (err) return console.error(err);
    const cp_id = res.rows[0].counterparty_id;
    pool.query(`
        SELECT id, doc_number, total_amount, status FROM client_orders WHERE counterparty_id = $1
    `, [cp_id], (e, r) => {
        console.log(r.rows);
        pool.end();
    });
});
