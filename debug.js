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
        console.log('\n--- STEP 1: DEGBUG INVENTORY MOVEMENTS ---');
        const result = await pool.query(`
            SELECT id, movement_type, description, linked_order_item_id, item_id
            FROM inventory_movements 
            WHERE movement_type = 'sales_shipment' 
            ORDER BY created_at DESC 
            LIMIT 3
        `);
        console.log('Real inventory_movements (sales_shipment):');
        console.log(JSON.stringify(result.rows, null, 2));

        const orderResult = await pool.query(`
            SELECT id, doc_number, status, pending_debt FROM client_orders ORDER BY created_at DESC LIMIT 3
        `);
        console.log('\nReal client_orders:');
        console.log(JSON.stringify(orderResult.rows, null, 2));

        console.log('\n--- STEP 2: DEBUG API ROUTES DATA ---');
        const apiSalesOrders = await pool.query(`
            SELECT o.id, o.doc_number, o.status, o.pending_debt
            FROM client_orders o
            WHERE o.status IN ('pending', 'processing')
            ORDER BY o.created_at DESC LIMIT 100
        `);
        console.log(`GET /api/sales/orders returns: ${apiSalesOrders.rowCount} orders`);
        const targetOrderInSales = apiSalesOrders.rows.find(row => row.doc_number === 'ЗК-00001' || row.id === 1);
        console.log('Is ЗК-00001 in /api/sales/orders? ', !!targetOrderInSales);

        const apiInvoicesData = await pool.query(`
            SELECT o.doc_number, o.pending_debt, o.status
            FROM client_orders o
            WHERE o.status IN ('pending', 'processing') AND o.pending_debt > 0
        `);
        const targetOrdInInvoices = apiInvoicesData.rows.find(row => row.doc_number === 'ЗК-00001' || row.doc_number.includes('00001'));
        console.log('Is ЗК-00001 in /api/invoices? ', !!targetOrdInInvoices);

    } catch(e) {
        console.error('SQL_ERROR:', e.message);
    } finally {
        await pool.end();
    }
}
run();
