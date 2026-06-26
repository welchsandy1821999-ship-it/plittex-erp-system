# -*- coding: utf-8 -*-
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('159.194.207.6', username='root', password='+JjJWwaK5+6b', timeout=30)

def run(cmd):
    _, o, e = client.exec_command(cmd, timeout=20)
    out = o.read().decode(errors='replace').strip()
    err = e.read().decode(errors='replace').strip()
    print(f'>>> {cmd}')
    if out: print(out[-2000:])
    if err: print('STDERR:', err[-500:])
    print()

run('systemctl status nginx --no-pager | tail -20')
run('curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/')
run('nginx -t 2>&1')
run('ss -tlnp | grep -E "3000|80|443"')
client.close()
print('Done')
