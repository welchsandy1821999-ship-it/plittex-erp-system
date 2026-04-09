const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

(async () => {
  // 1. Check item_reservations
  try {
    const r = await pool.query("SELECT count(*) as cnt FROM item_reservations");
    console.log('item_reservations: EXISTS, ' + r.rows[0].cnt + ' rows');
  } catch(e) { console.log('item_reservations: ' + (e.message.includes('не существует') ? 'DOES NOT EXIST' : e.message)); }

  // 2. Check timesheets
  try {
    const r = await pool.query("SELECT count(*) as cnt FROM timesheets");
    console.log('timesheets: EXISTS, ' + r.rows[0].cnt + ' rows');
  } catch(e) { console.log('timesheets: ' + (e.message.includes('не существует') ? 'DOES NOT EXIST' : e.message)); }

  // 3. Check FK references to these tables
  const fks = await pool.query(
    "SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table " +
    "FROM information_schema.table_constraints tc " +
    "JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name " +
    "JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name " +
    "WHERE tc.constraint_type = 'FOREIGN KEY' " +
    "AND (ccu.table_name = 'item_reservations' OR ccu.table_name = 'timesheets')"
  );
  console.log('\nFK references TO item_reservations/timesheets: ' + fks.rows.length);
  fks.rows.forEach(r => console.log('  ' + r.table_name + '.' + r.column_name + ' -> ' + r.foreign_table));

  // 4. Check FK references FROM these tables
  const fksFrom = await pool.query(
    "SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table " +
    "FROM information_schema.table_constraints tc " +
    "JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name " +
    "JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name " +
    "WHERE tc.constraint_type = 'FOREIGN KEY' " +
    "AND (tc.table_name = 'item_reservations' OR tc.table_name = 'timesheets')"
  );
  console.log('\nFK references FROM item_reservations/timesheets: ' + fksFrom.rows.length);
  fksFrom.rows.forEach(r => console.log('  ' + r.table_name + '.' + r.column_name + ' -> ' + r.foreign_table));

  await pool.end();
})();
