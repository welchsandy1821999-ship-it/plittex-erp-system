
# -*- coding: utf-8 -*-
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('159.194.207.6', username='root', password='+JjJWwaK5+6b', timeout=30)

def run(cmd, timeout=60):
    _, o, e = client.exec_command(cmd, timeout=timeout)
    out  = o.read().decode(errors='replace').strip()
    err  = e.read().decode(errors='replace').strip()
    code = o.channel.recv_exit_status()
    print(f">>> {cmd[:120]}")
    if out: print(out[:2000])
    if err and code != 0: print(f"STDERR: {err[:400]}")
    print(f"[exit={code}]\n")
    return code, out

APP_DIR = '/root/plittex-erp'

print("=== Принудительный git pull (stash + pull) ===")
# Сохраняем локальные изменения в stash, тянем код, игнорируем stash
run(f"cd {APP_DIR} && git stash 2>&1")
run(f"cd {APP_DIR} && git pull origin main 2>&1")
# Проверяем что reports.js обновился
run(f"cd {APP_DIR} && git log --oneline -3 2>&1")
run(f"cd {APP_DIR} && grep -n 'BUG-FIX' routes/reports.js | head -5 2>&1")

print("\n=== Перезапуск PM2 после pull ===")
run("pm2 restart plittex-erp 2>&1")
run("pm2 status 2>&1")

print("\n✅ Готово")
client.close()
