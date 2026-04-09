const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

(async () => {
  try {
    await pool.query('ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false');
    console.log('Added is_deleted to salary_payments');
    
    await pool.query('ALTER TABLE salary_adjustments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false');
    console.log('Added is_deleted to salary_adjustments');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await pool.end();
  }
})();
