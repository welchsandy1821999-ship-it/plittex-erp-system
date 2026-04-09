require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

async function run() {
    try {
        // Simulate EXACTLY what the browser does: fetch /api/invoices
        console.log('=== Simulating GET /api/invoices ===');
        const result = await pool.query(`
                SELECT 
                    i.id, 
                    i.invoice_number, 
                    i.total_amount as amount, 
                    i.purpose as description, 
                    i.status, 
                    i.created_at,
                    TO_CHAR(i.created_at, 'DD.MM.YYYY') as date_formatted,
                    c.name as counterparty_name, 
                    c.id as counterparty_id,
                    false as is_order
                FROM invoices i
                JOIN counterparties c ON i.counterparty_id = c.id
                WHERE i.status = 'pending'

                UNION ALL

                SELECT 
                    o.id, 
                    o.doc_number as invoice_number, 
                    o.pending_debt as amount, 
                    'Остаток долга по заказу № ' || o.doc_number as description, 
                    'pending' as status, 
                    o.created_at,
                    TO_CHAR(o.created_at, 'DD.MM.YYYY') as date_formatted,
                    c.name as counterparty_name, 
                    o.counterparty_id as counterparty_id,
                    true as is_order
                FROM client_orders o
                LEFT JOIN counterparties c ON o.counterparty_id = c.id
                WHERE o.status IN ('pending', 'processing') AND o.pending_debt > 0

                ORDER BY created_at DESC
        `);
        
        // This is EXACTLY what res.json(result.rows) sends to the browser
        const jsonOutput = JSON.stringify(result.rows);
        const parsed = JSON.parse(jsonOutput);
        
        console.log(`Rows: ${parsed.length}`);
        console.log('Type check: Array.isArray =', Array.isArray(parsed));
        if (parsed.length > 0) {
            console.log('First row keys:', Object.keys(parsed[0]));
            console.log('First row:', JSON.stringify(parsed[0], null, 2));
            
            // Simulate frontend filter
            const filtered = parsed.filter(i => i.status !== 'paid');
            console.log(`After filter (status !== paid): ${filtered.length} rows`);
        }

        // Also check: does the invoices table even exist and have the right columns?
        console.log('\n=== Check invoices table ===');
        const invCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'invoices' ORDER BY ordinal_position`);
        console.log('invoices columns:', invCols.rows.map(r => r.column_name).join(', '));
        
        const invCount = await pool.query(`SELECT COUNT(*) as cnt, COUNT(*) FILTER (WHERE status = 'pending') as pending FROM invoices`);
        console.log('invoices total:', invCount.rows[0].cnt, '| pending:', invCount.rows[0].pending);

    } catch(e) {
        console.error('ERROR:', e.message);
        console.error('DETAIL:', e.detail || 'none');
    } finally {
        await pool.end();
    }
}
run();
