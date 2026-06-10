#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Скрипт настройки SSL для erp.plittex.ru
# Запускать на сервере (Linux) от root или через sudo
# ═══════════════════════════════════════════════════════════

set -e

DOMAIN="erp.plittex.ru"
EMAIL="admin@plittex.ru"   # ← Замени на реальный email для Let's Encrypt

echo "═══ 1/4: Установка nginx и certbot ═══"
apt-get update
apt-get install -y nginx certbot python3-certbot-nginx

echo "═══ 2/4: Копирование конфига nginx ═══"
cp nginx-erp.conf /etc/nginx/sites-available/$DOMAIN

# Удаляем дефолт если мешает
rm -f /etc/nginx/sites-enabled/default

# Включаем наш сайт
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN

echo "═══ 3/4: Проверка и перезагрузка nginx ═══"
nginx -t
systemctl reload nginx

echo "═══ 4/4: Получение SSL-сертификата Let's Encrypt ═══"
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL

echo ""
echo "✅ Готово! https://$DOMAIN должен работать."
echo "   Автообновление сертификата: certbot уже добавил cron/timer."
echo "   Проверка: sudo certbot renew --dry-run"
