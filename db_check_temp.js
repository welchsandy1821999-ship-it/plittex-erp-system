require('dotenv').config();
const {Pool} = require('pg');
const p = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME
});
p.query("SELECT e.full_name, (SELECT MAX(production_date) FROM production_batches WHERE shift_name = e.full_name) AS last_shift_at FROM employees e")
  .then(res => {
    console.log('Employees API logic:');
    console.table(res.rows.filter(r => r.last_shift_at !== null).concat(res.rows.filter(r => r.last_shift_at === null).slice(0, 3)));
    return p.query('SELECT DISTINCT shift_name FROM production_batches LIMIT 5');
  })
  .then(res => {
    console.log('\nBatches shift_name:');
    console.table(res.rows);
    p.end();
  })
  .catch(e => {
    console.error(e);
    p.end();
  });
