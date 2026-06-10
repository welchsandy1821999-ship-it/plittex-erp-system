#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import paramiko, sys

HOST = "159.194.207.6"
USER = "root"
PASS = "+JjJWwaK5+6b"
DOMAIN = "erp.plittex.ru"
EMAIL = "admin@plittex.ru"

# HTTP-only config (no SSL block - certbot will add it automatically)
NGINX_HTTP_CONF = """server {
    listen 80;
    listen [::]:80;
    server_name erp.plittex.ru;
    client_max_body_size 50M;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
"""

def run(client, cmd, timeout=120):
    print(f"\n>>> {cmd[:80]}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors='replace').strip()
    err = stderr.read().decode(errors='replace').strip()
    code = stdout.channel.recv_exit_status()
    if out:
        print("OUT:", out[:800])
    if err and code != 0:
        print("ERR:", err[:400])
    print(f"[exit: {code}]")
    return code, out, err

def main():
    print(f"=== Connecting to {HOST} ===")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=15)
    print("Connected OK!")

    # Check state
    print("\n=== Server state ===")
    run(client, "cat /etc/os-release | head -3")
    run(client, "systemctl is-active nginx 2>/dev/null || echo nginx-not-active")
    run(client, "curl -s -o /dev/null -w 'App health: %{http_code}' http://localhost:3000/api/health 2>/dev/null || echo app-not-running")

    # Install certbot if needed
    print("\n=== Install certbot ===")
    run(client, "apt-get update -qq", timeout=120)
    run(client, "DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-nginx", timeout=300)

    # Write HTTP-only nginx config via SFTP
    print(f"\n=== Write nginx config (HTTP only) ===")
    sftp = client.open_sftp()
    with sftp.open(f"/etc/nginx/sites-available/{DOMAIN}", 'w') as f:
        f.write(NGINX_HTTP_CONF)
    sftp.close()
    print(f"Written: /etc/nginx/sites-available/{DOMAIN}")

    run(client, "rm -f /etc/nginx/sites-enabled/default")
    run(client, f"ln -sf /etc/nginx/sites-available/{DOMAIN} /etc/nginx/sites-enabled/{DOMAIN}")
    run(client, "mkdir -p /var/www/html")

    # Test and reload nginx
    print("\n=== Test nginx config ===")
    code, _, _ = run(client, "nginx -t")
    if code != 0:
        print("FAIL: nginx config invalid!")
        client.close()
        sys.exit(1)
    run(client, "systemctl reload nginx")
    print("nginx reloaded OK")

    # Get SSL cert - certbot will add SSL server block automatically
    print(f"\n=== Run certbot for {DOMAIN} ===")
    code, out, err = run(client,
        f"certbot --nginx -d {DOMAIN} --non-interactive --agree-tos -m {EMAIL} --redirect",
        timeout=300
    )
    if code == 0:
        print("SSL certificate obtained!")
    else:
        print(f"certbot exit code {code}")
        print("Check DNS: dig A erp.plittex.ru")

    # Add WebSocket headers to SSL block if missing
    run(client,
        f"grep -q 'Upgrade' /etc/nginx/sites-available/{DOMAIN} || "
        f"sed -i '/proxy_read_timeout/i\\        proxy_set_header Upgrade $http_upgrade;\\n        proxy_set_header Connection upgrade;\\n        proxy_cache_bypass $http_upgrade;' "
        f"/etc/nginx/sites-available/{DOMAIN}",
        timeout=10
    )
    run(client, "nginx -t && systemctl reload nginx")

    # Final check
    print("\n=== Final check ===")
    run(client, "systemctl status nginx --no-pager | head -6")
    run(client, f"certbot certificates 2>/dev/null | grep -A4 '{DOMAIN}' || echo 'no cert found'")
    run(client, f"curl -sk -o /dev/null -w 'HTTPS app: %{{http_code}}' https://{DOMAIN}/api/health || echo 'not reachable'")

    client.close()
    print("\nDone! Check: https://erp.plittex.ru")

if __name__ == "__main__":
    main()
