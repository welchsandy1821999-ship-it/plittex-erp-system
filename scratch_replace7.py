import re

path = r"c:\Users\Пользователь\Desktop\plittex-erp\routes\sales.js"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

# Fix 1: /api/sales/orders (client_balance)
target1 = """                    -- 💰 Реальный баланс контрагента через транзакции
                    (SELECT 
                        COALESCE(SUM(CASE WHEN co2.status = 'completed' THEN co2.total_amount ELSE 0 END), 0) +
                        COALESCE(SUM(CASE WHEN t2.transaction_type = 'expense' THEN t2.amount ELSE 0 END), 0) -
                        COALESCE((SELECT COALESCE(SUM(amount), 0) FROM inventory_movements WHERE supplier_id = o.counterparty_id AND movement_type = 'purchase'), 0) -
                        COALESCE(SUM(CASE WHEN t2.transaction_type = 'income' THEN t2.amount ELSE 0 END), 0)
                    FROM counterparties cp2
                    LEFT JOIN transactions t2 ON cp2.id = t2.counterparty_id AND COALESCE(t2.is_deleted, false) = false
                    LEFT JOIN client_orders co2 ON cp2.id = co2.counterparty_id
                    WHERE cp2.id = o.counterparty_id
                    ) as client_balance,"""

replacement1 = """                    -- 💰 Реальный баланс контрагента через транзакции
                    (
                        (SELECT COALESCE(SUM(total_amount), 0) FROM client_orders WHERE counterparty_id = o.counterparty_id AND status = 'completed') +
                        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = o.counterparty_id AND transaction_type = 'expense' AND COALESCE(is_deleted, false) = false) -
                        (SELECT COALESCE(SUM(amount), 0) FROM inventory_movements WHERE supplier_id = o.counterparty_id AND movement_type = 'purchase') -
                        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = o.counterparty_id AND transaction_type = 'income' AND COALESCE(is_deleted, false) = false)
                    ) as client_balance,"""

if target1 in text:
    text = text.replace(target1, replacement1)
    print("Fixed target1")
else:
    print("Failed target1")

# Fix 2: /api/counterparties/:id/balance (realBalance)
target2 = """            const balRes = await pool.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN co.status = 'completed' THEN co.total_amount ELSE 0 END), 0) as our_shipments,
                    COALESCE(SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END), 0) as our_payments,
                    COALESCE((SELECT COALESCE(SUM(amount), 0) FROM inventory_movements WHERE supplier_id = $1 AND movement_type = 'purchase'), 0) as their_shipments,
                    COALESCE(SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END), 0) as their_payments
                FROM counterparties cp
                LEFT JOIN transactions t ON cp.id = t.counterparty_id AND COALESCE(t.is_deleted, false) = false
                LEFT JOIN client_orders co ON cp.id = co.counterparty_id
                WHERE cp.id = $1
            `, [cpId]);"""

replacement2 = """            const balRes = await pool.query(`
                SELECT
                    (SELECT COALESCE(SUM(total_amount), 0) FROM client_orders WHERE counterparty_id = $1 AND status = 'completed') as our_shipments,
                    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'expense' AND COALESCE(is_deleted, false) = false) as our_payments,
                    (SELECT COALESCE(SUM(amount), 0) FROM inventory_movements WHERE supplier_id = $1 AND movement_type = 'purchase') as their_shipments,
                    (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE counterparty_id = $1 AND transaction_type = 'income' AND COALESCE(is_deleted, false) = false) as their_payments
            `, [cpId]);"""

if target2 in text:
    text = text.replace(target2, replacement2)
    print("Fixed target2")
else:
    print("Failed target2")


with open(path, "w", encoding="utf-8") as f:
    f.write(text)
    print("Written")
