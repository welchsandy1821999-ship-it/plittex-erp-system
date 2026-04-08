const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://postgres:Plittex_2026_SQL@localhost:5432/plittex_erp'
});

async function runAudit() {
    try {
        const fkRes = await pool.query(`
            SELECT conname, pg_class.relname as table_name, confdeltype 
            FROM pg_constraint 
            JOIN pg_class ON pg_class.oid = conrelid 
            WHERE confrelid = 'counterparties'::regclass;
        `);
        console.log("AUDIT-003 (CASCADE DELETE counterparties):");
        fkRes.rows.forEach(row => {
            const rule = row.confdeltype === 'c' ? "CASCADE" : (row.confdeltype === 'r' ? "RESTRICT" : row.confdeltype);
            console.log(`  Table: ${row.table_name} -> Rule: ${rule}`);
        });

        const checkTable = await pool.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'item_reservations')`);
        console.log(`AUDIT-004 (item_reservations): ${checkTable.rows[0].exists ? 'EXISTS!' : 'DELETED'}`);

    } catch(e) {
        console.error("DB check failed: ", e.message);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

runAudit();
