const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

(async () => {
  // 1. All existing CHECK constraints
  const checks = await pool.query(
    "SELECT tc.table_name, tc.constraint_name, cc.check_clause " +
    "FROM information_schema.table_constraints tc " +
    "JOIN information_schema.check_constraints cc ON tc.constraint_name = cc.constraint_name " +
    "WHERE tc.constraint_type = 'CHECK' AND tc.table_schema = 'public' " +
    "ORDER BY tc.table_name"
  );
  console.log('=== EXISTING CHECK CONSTRAINTS ===');
  if (checks.rows.length === 0) {
    console.log('NONE FOUND — No CHECK constraints exist in public schema.');
  } else {
    checks.rows.forEach(r => console.log(r.table_name + '.' + r.constraint_name + ': ' + r.check_clause));
  }
  
  // 2. Check for dirty data in target columns
  const dirtyQueries = [
    { label: 'items.price < 0', sql: "SELECT count(*) as cnt FROM items WHERE price < 0" },
    { label: 'items.min_stock < 0', sql: "SELECT count(*) as cnt FROM items WHERE min_stock < 0" },
    { label: 'total_stock.physical_qty < 0', sql: "SELECT count(*) as cnt FROM total_stock WHERE physical_qty < 0" },
    { label: 'client_order_items.qty < 0', sql: "SELECT count(*) as cnt FROM client_order_items WHERE qty < 0" },
    { label: 'client_order_items.price < 0', sql: "SELECT count(*) as cnt FROM client_order_items WHERE price < 0" },
    { label: 'transactions.amount < 0', sql: "SELECT count(*) as cnt FROM transactions WHERE amount < 0" },
  ];
  console.log('\n=== DIRTY DATA CHECK (rows with negative values) ===');
  for (const q of dirtyQueries) {
    try {
      const r = await pool.query(q.sql);
      const cnt = parseInt(r.rows[0].cnt);
      console.log(q.label + ': ' + cnt + (cnt > 0 ? ' ⚠️ DIRTY!' : ' ✅'));
    } catch(e) {
      console.log(q.label + ': TABLE/COLUMN MISSING - ' + e.message.substring(0,100));
    }
  }
  
  // 3. Column types for context
  const cols = await pool.query(
    "SELECT table_name, column_name, data_type, is_nullable " +
    "FROM information_schema.columns " +
    "WHERE table_schema = 'public' " +
    "AND table_name IN ('items','total_stock','client_order_items','transactions') " +
    "AND column_name IN ('price','min_stock','physical_qty','qty','amount','quantity') " +
    "ORDER BY table_name, column_name"
  );
  console.log('\n=== COLUMN TYPES ===');
  cols.rows.forEach(r => console.log(r.table_name + '.' + r.column_name + ' -> ' + r.data_type + ' (nullable: ' + r.is_nullable + ')'));
  
  // 4. Check additional tables that may need protection
  const extraCheck = [
    { label: 'salary_adjustments.amount < 0', sql: "SELECT count(*) as cnt FROM salary_adjustments WHERE amount < 0" },
    { label: 'salary_payments.amount < 0', sql: "SELECT count(*) as cnt FROM salary_payments WHERE amount < 0" },
    { label: 'employees.base_salary < 0', sql: "SELECT count(*) as cnt FROM employees WHERE base_salary < 0" },
    { label: 'inventory_movements.quantity < 0', sql: "SELECT count(*) as cnt FROM inventory_movements WHERE quantity < 0" },
  ];
  console.log('\n=== EXTRA DIRTY DATA CHECK ===');
  for (const q of extraCheck) {
    try {
      const r = await pool.query(q.sql);
      const cnt = parseInt(r.rows[0].cnt);
      console.log(q.label + ': ' + cnt + (cnt > 0 ? ' ⚠️ DIRTY!' : ' ✅'));
    } catch(e) {
      console.log(q.label + ': N/A - ' + e.message.substring(0,80));
    }
  }

  await pool.end();
})();
