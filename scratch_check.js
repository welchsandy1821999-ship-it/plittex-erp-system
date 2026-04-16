const { Pool } = require("pg");
const pool = new Pool({ user: "postgres", password: "Plittex_2026_SQL", database: "plittex_erp" });
pool.query(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_batches_status'`, (err, res) => {
    console.log(res?.rows);
    pool.end();
});
