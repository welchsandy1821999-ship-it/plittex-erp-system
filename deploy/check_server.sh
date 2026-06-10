#!/bin/bash
PASS='+JjJWwaK5+6b'
HOST='root@159.194.207.6'

# Install sshpass if needed
if ! which sshpass > /dev/null 2>&1; then
    apt-get install -y sshpass > /dev/null 2>&1
fi

sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$HOST" '
echo "=== OS ==="
cat /etc/os-release | head -3

echo "=== NGINX ==="
which nginx 2>/dev/null || echo "nginx NOT installed"
nginx -v 2>&1 || true
systemctl is-active nginx 2>/dev/null || echo "nginx not running"

echo "=== CERTBOT ==="
which certbot 2>/dev/null || echo "certbot NOT installed"

echo "=== PM2 ==="
pm2 list 2>/dev/null | head -15 || echo "pm2 not found"

echo "=== APP PORTS ==="
ss -tlnp 2>/dev/null | grep -E "3000|80|443" || netstat -tlnp 2>/dev/null | grep -E "3000|80|443" || echo "no ports found"

echo "=== DOCKER ==="
docker ps 2>/dev/null | head -10 || echo "docker not running"

echo "=== DNS CHECK ==="
nslookup erp.plittex.ru 2>/dev/null || echo "nslookup failed"
'
