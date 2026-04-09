const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

(async () => {
  // Get all numeric columns for target tables
  const cols = await pool.query(
    "SELECT table_name, column_name, data_type, is_nullable, column_default " +
    "FROM information_schema.columns " +
    "WHERE table_schema = 'public' " +
    "AND table_name IN ('items','total_stock','warehouse_stock','client_order_items','transactions','salary_adjustments','salary_payments','employees','inventory_movements') " +
    "AND data_type IN ('numeric','integer','bigint','real','double precision','smallint') " +
    "ORDER BY table_name, ordinal_position"
  );
  console.log('=== NUMERIC COLUMNS IN TARGET TABLES ===');
  cols.rows.forEach(r => console.log(r.table_name + '.' + r.column_name + ' -> ' + r.data_type + ' (nullable: ' + r.is_nullable + ', default: ' + r.column_default + ')'));

  // Check if total_stock exists, or what the actual stock table is
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%stock%' ORDER BY table_name"
  );
  console.log('\n=== STOCK-RELATED TABLES ===');
  tables.rows.forEach(r => console.log(r.table_name));

  // Check dirty data for inventory_movements (145 negative) — are these legitimate (e.g. outbound movements)?
  const movTypes = await pool.query(
    "SELECT movement_type, count(*) as cnt, min(quantity) as min_qty, max(quantity) as max_qty " +
    "FROM inventory_movements WHERE quantity < 0 GROUP BY movement_type ORDER BY movement_type"
  );
  console.log('\n=== NEGATIVE inventory_movements BY TYPE ===');
  movTypes.rows.forEach(r => console.log(r.movement_type + ': ' + r.cnt + ' rows (min: ' + r.min_qty + ', max: ' + r.max_qty + ')'));

  // Check salary_adjustments dirty data
  const salAdj = await pool.query(
    "SELECT type, count(*) as cnt, min(amount) as min_amt FROM salary_adjustments WHERE amount < 0 GROUP BY type"
  );
  console.log('\n=== NEGATIVE salary_adjustments BY TYPE ===');
  salAdj.rows.forEach(r => console.log(r.type + ': ' + r.cnt + ' rows (min: ' + r.min_amt + ')'));

  // Check items — what is the price column actually called?
  const itemCols = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'items' AND table_schema = 'public' ORDER BY ordinal_position"
  );
  console.log('\n=== ALL COLUMNS IN items ===');
  itemCols.rows.forEach(r => console.log(r.column_name + ' -> ' + r.data_type));

  // Check client_order_items — what is qty column?
  const coiCols = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'client_order_items' AND table_schema = 'public' ORDER BY ordinal_position"
  );
  console.log('\n=== ALL COLUMNS IN client_order_items ===');
  coiCols.rows.forEach(r => console.log(r.column_name + ' -> ' + r.data_type));

  await pool.end();
})();
