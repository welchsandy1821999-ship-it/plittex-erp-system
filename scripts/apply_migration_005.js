const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '005_add_check_constraints.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ Migration 005_add_check_constraints.sql applied successfully!');
    
    // Verify: count all CHECK constraints now
    const res = await pool.query(
      "SELECT tc.table_name, tc.constraint_name, cc.check_clause " +
      "FROM information_schema.table_constraints tc " +
      "JOIN information_schema.check_constraints cc ON tc.constraint_name = cc.constraint_name " +
      "WHERE tc.constraint_type = 'CHECK' AND tc.table_schema = 'public' " +
      "AND tc.constraint_name LIKE 'chk_%' " +
      "ORDER BY tc.table_name, tc.constraint_name"
    );
    console.log('\n=== ALL chk_* CONSTRAINTS AFTER MIGRATION ===');
    res.rows.forEach(r => console.log(r.table_name + ' | ' + r.constraint_name + ' | ' + r.check_clause));
    console.log('\nTotal: ' + res.rows.length + ' constraints');
  } catch (e) {
    console.error('❌ Migration FAILED:', e.message);
  }
  await pool.end();
})();
