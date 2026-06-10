#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('159.194.207.6', username='root', password='+JjJWwaK5+6b', timeout=15)

def run(cmd):
    s,o,e = client.exec_command(cmd, timeout=30)
    out = o.read().decode(errors='replace').strip()
    code = o.channel.recv_exit_status()
    print(f">>> {cmd[:80]}")
    if out: print(out[:800])
    print(f"[{code}]\n")

# Verify what IP our server has vs what DNS resolves to
run("curl -s ifconfig.me")
run("dig erp.plittex.ru A +short 2>/dev/null || nslookup erp.plittex.ru | grep Address")

client.close()
