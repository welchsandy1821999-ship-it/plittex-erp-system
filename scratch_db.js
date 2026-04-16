const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', database: 'plittex_erp' });

async function run() {
    try {
        const orderRes = await pool.query("SELECT * FROM client_orders WHERE doc_number='ЗК-00026'");
        const order = orderRes.rows[0];
        console.log("=== ORDER ===");
        console.log(order);

        if (order) {
            const cpRes = await pool.query("SELECT * FROM counterparties WHERE id=$1", [order.counterparty_id]);
            console.log("\n=== CLIENT ===");
            console.log(cpRes.rows[0]);

            const balRes = await pool.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN co.status = 'completed' THEN co.total_amount ELSE 0 END), 0) as our_shipments,
                    COALESCE(SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END), 0) as our_payments,
                    COALESCE((SELECT COALESCE(SUM(amount), 0) FROM inventory_movements WHERE supplier_id = $1 AND movement_type = 'purchase'), 0) as their_shipments,
                    COALESCE(SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END), 0) as their_payments,
                    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'income') as raw_income,
                    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'expense') as raw_expense,
                    (SELECT COALESCE(SUM(total_amount), 0) FROM client_orders WHERE counterparty_id = $1 AND status != 'cancelled') as all_orders_amount
                FROM counterparties cp
                LEFT JOIN transactions t ON cp.id = t.counterparty_id AND COALESCE(t.is_deleted, false) = false
                LEFT JOIN client_orders co ON cp.id = co.counterparty_id
                WHERE cp.id = $1
                GROUP BY cp.id
            `, [order.counterparty_id]);
            
            console.log("\n=== AGGREGATES ===");
            console.log(balRes.rows[0]);

            // What is the projected_balance calculation from routes/sales.js ?
            const projRes = await pool.query(`SELECT COALESCE(SUM(pending_debt), 0) * -1 as projected_balance FROM client_orders WHERE counterparty_id = $1 AND status != 'cancelled'`, [order.counterparty_id]);
            console.log("\n=== PROJECTED BALANCE ===");
            console.log(projRes.rows[0]);
        }
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
run();
