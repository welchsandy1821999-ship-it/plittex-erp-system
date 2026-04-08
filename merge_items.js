const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'plittex_erp',
  password: 'Plittex_2026_SQL',
  port: 5432
});

async function run() {
  const BAD_ID = 511; // Пигмент (Белый)
  const GOOD_ID = 161; // Пигмент (диоксид/белый)
  
  try {
    const updateQueries = [
      `UPDATE inventory_movements SET item_id = $1 WHERE item_id = $2`,
      `UPDATE specification_items SET material_id = $1 WHERE material_id = $2`,
    ];

    for (let q of updateQueries) {
      try {
        const res = await pool.query(q, [GOOD_ID, BAD_ID]);
        console.log(`Executed: ${q.split('SET')[0]} - Updated ${res.rowCount} rows`);
      } catch (e) {
        console.error(`Failed ${q}:`, e.message);
      }
    }

    // Delete the bad item
    const delRes = await pool.query(`DELETE FROM items WHERE id = $1`, [BAD_ID]);
    console.log(`Deleted ${delRes.rowCount} items (BAD_ID = ${BAD_ID})`);

    console.log('Migration successful');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
}
run();
