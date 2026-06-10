
# -*- coding: utf-8 -*-
import subprocess, sys, io
try:
    import paramiko
except ImportError:
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'paramiko', '-q'])
    import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HOST = '159.194.207.6'
USER_SSH = 'root'
PASSWORD = '+JjJWwaK5+6b'
DB = 'plittex_erp'
DB_USER = 'plittex'
DB_PASS = 'ERP_secret_2026'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER_SSH, password=PASSWORD, timeout=15)
print("Connected!")

sftp = client.open_sftp()

# 1. Деплоим salary.js (frontend)
sftp.put(
    r'c:\Users\Пользователь\Desktop\plittex-erp\public\js\salary.js',
    '/root/plittex-erp/public/js/salary.js'
)
print("salary.js -> server: OK")

# 2. Деплоим routes/sales.js (backend)
sftp.put(
    r'c:\Users\Пользователь\Desktop\plittex-erp\routes\sales.js',
    '/root/plittex-erp/routes/sales.js'
)
print("routes/sales.js -> server: OK")

sftp.close()

def run(client, label, sql):
    print(f"\n=== {label} ===")
    cmd = f"PGPASSWORD='{DB_PASS}' psql -h localhost -U {DB_USER} -d {DB} -c \"{sql}\" 2>&1"
    stdin, stdout, stderr = client.exec_command(cmd, timeout=15)
    out = stdout.read().decode('utf-8', errors='replace')
    if out.strip(): print(out[:3000])

# 3. DB hotfix: проверяем не создан ли уже salary_adjustments для tx 16738
run(client, "Есть ли уже salary_adjustment для tx 16738",
    "SELECT id, employee_id, month_str, amount, description FROM salary_adjustments WHERE linked_transaction_id=16738;")

# 4. Создаём salary_adjustments для текущего возврата (если нет)
run(client, "Создаём salary_adjustments для ВЗ-371815 (tx 16738)",
    """INSERT INTO salary_adjustments (employee_id, month_str, amount, category, description, counterparty_id, linked_transaction_id, cash_posting_mode, operation_kind, source_module)
       SELECT 14, '2026-06', 8479.60, 'Возврат товара',
              'Возврат аванса (продукцией) по заказу ZK-00099: Возврат от покупателя VZ-371815 [Боднарчук Р.Р.]',
              218, 16738, 'none', 'return', 'sales'
       WHERE NOT EXISTS (SELECT 1 FROM salary_adjustments WHERE linked_transaction_id=16738);""")

# 5. Проверяем что запись создана
run(client, "ПРОВЕРКА salary_adjustments для Боднарчук (2026-06)",
    "SELECT id, employee_id, month_str, amount, category, description FROM salary_adjustments WHERE employee_id=14 AND month_str='2026-06' AND COALESCE(is_deleted,false)=false;")

# 6. Проверяем salary_payments (не должно быть 'return' entries)
run(client, "ПРОВЕРКА salary_payments для employee 14 в июне 2026",
    "SELECT id, employee_id, amount, payment_date, payment_type, description FROM salary_payments WHERE employee_id=14 AND payment_date >= '2026-06-01' AND COALESCE(is_deleted,false)=false;")

# 7. Перезапускаем PM2
print("\n=== RESTART PM2 ===")
stdin, stdout, stderr = client.exec_command("cd /root/plittex-erp && pm2 restart plittex-erp 2>&1", timeout=20)
out = stdout.read().decode('utf-8', errors='replace')
print(out[:500] if out.strip() else "(no output)")

client.close()
print("\n=== DONE ===")
