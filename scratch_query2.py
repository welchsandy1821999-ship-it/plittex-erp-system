import psycopg2
import psycopg2.extras
import json
conn = psycopg2.connect("postgresql://postgres:postgres@localhost:5432/plittex")
cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
cur.execute("SELECT id, doc_number, total_amount, paid_amount, pending_debt, payment_method, status FROM client_orders WHERE doc_number = 'ЗК-00026' LIMIT 1")
row = cur.fetchone()
if row:
    print(json.dumps(dict(row), default=str))
else:
    print("Not found")
conn.close()
