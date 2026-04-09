const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '006_add_performance_indexes.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ Migration 006_add_performance_indexes.sql applied successfully!');

    // Verify: count all indexes now
    const res = await pool.query(
      "SELECT count(*) as cnt FROM pg_indexes WHERE schemaname = 'public'"
    );
    console.log('Total indexes in DB: ' + res.rows[0].cnt);

    // Verify duplicate removed
    const dup = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_inv_item'"
    );
    console.log('Duplicate idx_inv_item removed: ' + (dup.rows.length === 0 ? '✅ YES' : '❌ NO'));

  } catch (e) {
    console.error('❌ Migration FAILED:', e.message);
  }
  await pool.end();
})();
