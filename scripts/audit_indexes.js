const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

(async () => {
  // 1. ALL existing indexes (non-PK, non-unique)
  const indexes = await pool.query(
    "SELECT schemaname, tablename, indexname, indexdef " +
    "FROM pg_indexes " +
    "WHERE schemaname = 'public' " +
    "ORDER BY tablename, indexname"
  );
  console.log('=== ALL EXISTING INDEXES ===');
  indexes.rows.forEach(r => console.log(r.tablename + ' | ' + r.indexname));
  console.log('Total: ' + indexes.rows.length);

  // 2. FK columns WITHOUT indexes (the killer query)
  const missingIdx = await pool.query(
    "SELECT " +
    "  c.conrelid::regclass AS table_name, " +
    "  a.attname AS fk_column, " +
    "  c.confrelid::regclass AS references_table, " +
    "  CASE WHEN i.indexrelid IS NOT NULL THEN 'YES' ELSE 'NO' END AS has_index " +
    "FROM pg_constraint c " +
    "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) " +
    "LEFT JOIN pg_index i ON i.indrelid = c.conrelid " +
    "  AND a.attnum = ANY(i.indkey) " +
    "WHERE c.contype = 'f' " +
    "ORDER BY table_name, fk_column"
  );
  console.log('\n=== FK COLUMNS — INDEX STATUS ===');
  missingIdx.rows.forEach(r => {
    const marker = r.has_index === 'NO' ? '❌ MISSING' : '✅';
    console.log(r.table_name + '.' + r.fk_column + ' -> ' + r.references_table + ' | ' + marker);
  });

  // 3. Table sizes to prioritize
  const sizes = await pool.query(
    "SELECT relname AS table_name, " +
    "  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size, " +
    "  reltuples::bigint AS row_estimate " +
    "FROM pg_class c " +
    "JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "WHERE n.nspname = 'public' AND c.relkind = 'r' " +
    "ORDER BY pg_total_relation_size(c.oid) DESC " +
    "LIMIT 20"
  );
  console.log('\n=== TOP 20 TABLES BY SIZE ===');
  sizes.rows.forEach(r => console.log(r.table_name + ' | ' + r.total_size + ' | ~' + r.row_estimate + ' rows'));

  // 4. production_batches indexes specifically (AUDIT-010)
  const pbIdx = await pool.query(
    "SELECT indexname, indexdef FROM pg_indexes " +
    "WHERE tablename = 'production_batches' AND schemaname = 'public'"
  );
  console.log('\n=== production_batches INDEXES ===');
  if (pbIdx.rows.length === 0) console.log('NONE (only PK)');
  pbIdx.rows.forEach(r => console.log(r.indexname + ': ' + r.indexdef));

  // 5. inventory_movements indexes
  const imIdx = await pool.query(
    "SELECT indexname, indexdef FROM pg_indexes " +
    "WHERE tablename = 'inventory_movements' AND schemaname = 'public'"
  );
  console.log('\n=== inventory_movements INDEXES ===');
  imIdx.rows.forEach(r => console.log(r.indexname + ': ' + r.indexdef));

  // 6. Check date columns for potential date-range indexes
  const dateCols = await pool.query(
    "SELECT table_name, column_name, data_type " +
    "FROM information_schema.columns " +
    "WHERE table_schema = 'public' " +
    "AND data_type IN ('timestamp without time zone','timestamp with time zone','date') " +
    "AND table_name IN ('transactions','inventory_movements','production_batches','client_orders','salary_payments','salary_adjustments','timesheet_records') " +
    "ORDER BY table_name, column_name"
  );
  console.log('\n=== DATE COLUMNS (candidates for range indexes) ===');
  dateCols.rows.forEach(r => console.log(r.table_name + '.' + r.column_name + ' (' + r.data_type + ')'));

  await pool.end();
})();
