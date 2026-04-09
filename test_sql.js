const { Pool } = require('pg');
const pool = new Pool({ database: 'plittex', user: 'postgres' });

async function run() {
    try {
        const query = `
                SELECT 
                    o.doc_number,
                    o.total_amount as revenue,
                    c.name as client_name,
                    o.created_at,
                    COALESCE(SUM(
                        ABS(m.quantity) * COALESCE(
                            (SELECT SUM(r.quantity_per_unit * ri_i.current_price) 
                             FROM recipes r
                             JOIN items ri_i ON ri_i.id = r.material_id
                             WHERE r.product_id = m.item_id),
                            i.purchase_price,
                            0
                        )
                    ), 0) as material_cost
                FROM client_orders o
                JOIN counterparties c ON o.counterparty_id = c.id
                LEFT JOIN inventory_movements m ON m.description LIKE '%' || o.doc_number || '%' AND m.movement_type = 'sales_shipment'
                LEFT JOIN items i ON m.item_id = i.id
                WHERE o.status = 'completed'
                GROUP BY o.id, o.doc_number, o.total_amount, c.name, o.created_at
                ORDER BY o.created_at DESC
                LIMIT 10
        `;
        await pool.query(query);
        console.log('Query successful');
    } catch(e) {
        console.error('SQL_ERROR:', e.message);
    } finally {
        await pool.end();
    }
}
run();
