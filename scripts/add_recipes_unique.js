const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

(async () => {
  try {
    // 1. Check for existing duplicates
    const dupes = await pool.query(
      "SELECT product_id, material_id, count(*) as cnt " +
      "FROM recipes GROUP BY product_id, material_id HAVING count(*) > 1"
    );
    console.log('=== DUPLICATE CHECK ===');
    if (dupes.rows.length > 0) {
      console.log('Found ' + dupes.rows.length + ' duplicate pairs. Cleaning...');
      for (const d of dupes.rows) {
        // Keep the one with the highest id, delete the rest
        await pool.query(
          "DELETE FROM recipes WHERE product_id = $1 AND material_id = $2 AND id NOT IN " +
          "(SELECT MAX(id) FROM recipes WHERE product_id = $1 AND material_id = $2)",
          [d.product_id, d.material_id]
        );
      }
      console.log('Duplicates cleaned.');
    } else {
      console.log('No duplicates found. ✅');
    }

    // 2. Check if constraint already exists
    const existing = await pool.query(
      "SELECT constraint_name FROM information_schema.table_constraints " +
      "WHERE table_name = 'recipes' AND constraint_type = 'UNIQUE'"
    );
    if (existing.rows.length > 0) {
      console.log('\n=== EXISTING UNIQUE CONSTRAINTS ===');
      existing.rows.forEach(r => console.log(r.constraint_name));
    }

    // 3. Add the UNIQUE constraint
    await pool.query(
      "ALTER TABLE recipes ADD CONSTRAINT unq_recipes_prod_mat UNIQUE (product_id, material_id)"
    );
    console.log('\n✅ UNIQUE constraint unq_recipes_prod_mat added successfully!');

  } catch (e) {
    if (e.message.includes('already exists') || e.message.includes('уже существует')) {
      console.log('\n✅ Constraint already exists, skipping.');
    } else {
      console.error('❌ ERROR:', e.message);
    }
  }
  await pool.end();
})();
