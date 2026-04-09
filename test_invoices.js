const { Pool } = require('pg');
const pool = new Pool({ database: 'plittex', user: 'postgres' });

async function run() {
    try {
        const query = `
                SELECT 
                    i.id, 
                    i.invoice_number, 
                    i.total_amount as amount, 
                    i.purpose as description, 
                    i.status, 
                    i.created_at,
                    TO_CHAR(i.created_at, 'DD.MM.YYYY') as date_formatted,
                    c.name as counterparty_name, 
                    c.id as cp_id,
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
                    o.counterparty_id as cp_id,
                    true as is_order
                FROM client_orders o
                LEFT JOIN counterparties c ON o.counterparty_id = c.id
                WHERE o.status IN ('pending', 'processing') AND o.pending_debt > 0

                ORDER BY created_at DESC
        `;
        await pool.query(query);
        console.log('GET /api/invoices works');
    } catch(e) {
        console.error('GET /api/invoices ERROR:', e.message);
    } finally {
        await pool.end();
    }
}
run();
