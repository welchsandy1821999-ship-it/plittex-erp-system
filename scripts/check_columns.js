const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

(async () => {
  try {
    const tables = ['production_batches', 'salary_payments', 'salary_adjustments'];
    
    for (const table of tables) {
      console.log(`\n=== Table: ${table} ===`);
      const res = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = $1 AND (column_name = 'is_deleted' OR column_name = 'status')
      `, [table]);
      
      if (res.rows.length === 0) {
         console.log('No is_deleted or status columns found.');
      } else {
         res.rows.forEach(r => console.log(`${r.column_name} (${r.data_type})`));
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
})();
