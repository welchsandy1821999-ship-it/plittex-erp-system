#!/usr/bin/env node
/**
 * SSL Setup v2 — пишем nginx конфиг через SFTP (без shell-экранирования)
 */

const { Client } = require('ssh2');

const HOST = '159.194.207.6';
const USER = 'root';
const PASS = '+JjJWwaK5+6b';
const DOMAIN = 'erp.plittex.ru';
const APP_PORT = 3000;

// Nginx конфиг — только HTTP (для certbot)
const NGINX_HTTP_CONF = `server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
    }
}
`;

function exec(conn, cmd, desc) {
  return new Promise((resolve, reject) => {
    if (desc) console.log(`\n[→] ${desc}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', d => { process.stdout.write(d.toString()); out += d.toString(); });
      stream.stderr.on('data', d => { process.stderr.write(d.toString()); out += d.toString(); });
      stream.on('close', code => {
        if (code !== 0) console.log(`[exit: ${code}]`);
        resolve({ code, out });
      });
    });
  });
}

function sftpWrite(conn, remotePath, content) {
  return new Promise((resolve, reject) => {
    console.log(`\n[SFTP] Writing ${remotePath}`);
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', () => { console.log(`[SFTP] Done.`); sftp.end(); resolve(); });
      stream.on('error', reject);
      stream.write(content);
      stream.end();
    });
  });
}

async function main() {
  const conn = new Client();

  await new Promise((resolve, reject) => {
    conn.on('ready', resolve);
    conn.on('error', reject);
    conn.connect({ host: HOST, username: USER, password: PASS, port: 22, readyTimeout: 15000 });
  });

  console.log('✅ SSH подключён к', HOST);

  try {
    // Шаг 1: Проверяем что nginx установлен
    await exec(conn, 'which nginx || apt-get install -y nginx -qq', 'Nginx установлен?');

    // Шаг 2: Удаляем все конфликтующие конфиги
    await exec(conn,
      `rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/${DOMAIN} /etc/nginx/sites-available/${DOMAIN}`,
      'Очистка конфликтующих конфигов'
    );

    // Шаг 3: Записываем чистый HTTP конфиг через SFTP
    await sftpWrite(conn, `/etc/nginx/sites-available/${DOMAIN}`, NGINX_HTTP_CONF);

    // Шаг 4: Включаем сайт
    await exec(conn,
      `ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}`,
      'Включение сайта'
    );

    // Шаг 5: Проверка и запуск nginx
    const test = await exec(conn, 'nginx -t', 'Проверка nginx конфига');
    if (test.code !== 0) {
      console.error('\n❌ nginx -t failed — смотрим детали...');
      await exec(conn, 'cat /etc/nginx/nginx.conf', 'main nginx.conf');
      await exec(conn, `cat /etc/nginx/sites-enabled/${DOMAIN}`, 'наш конфиг');
      conn.end();
      return;
    }

    await exec(conn, 'systemctl start nginx && systemctl enable nginx', 'Запуск nginx');
    await exec(conn, 'systemctl status nginx --no-pager | head -15', 'Статус nginx');

    // Шаг 6: Certbot
    console.log('\n[→] Установка certbot...');
    await exec(conn, 'apt-get install -y certbot python3-certbot-nginx -qq', 'Установка certbot');

    console.log('\n[→] Получение SSL сертификата Let\'s Encrypt...');
    const cert = await exec(conn,
      `certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos --email admin@plittex.ru --redirect 2>&1`,
      'certbot --nginx'
    );

    if (cert.code === 0) {
      console.log('\n✅ SSL сертификат получен!');
    } else {
      console.log('\n[!] certbot не сработал. Пробуем standalone...');
      // Остановим nginx, попробуем standalone
      await exec(conn, 'systemctl stop nginx', 'Стоп nginx для standalone certbot');
      const cert2 = await exec(conn,
        `certbot certonly --standalone -d ${DOMAIN} --non-interactive --agree-tos --email admin@plittex.ru 2>&1`,
        'certbot --standalone'
      );
      if (cert2.code === 0) {
        console.log('\n✅ Сертификат получен через standalone!');
        // Пишем полный HTTPS конфиг
        const NGINX_HTTPS_CONF = `server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
    }
}
`;
        await sftpWrite(conn, `/etc/nginx/sites-available/${DOMAIN}`, NGINX_HTTPS_CONF);
        await exec(conn, 'systemctl start nginx', 'Запуск nginx с SSL');
      } else {
        console.log('\n❌ Certbot не смог получить сертификат. Проверьте DNS:');
        await exec(conn, `nslookup ${DOMAIN} 8.8.8.8 2>/dev/null || dig ${DOMAIN} 2>/dev/null || echo "DNS tools not available"`, 'DNS проверка');
      }
    }

    // Шаг 7: Настройка auto-renew
    await exec(conn,
      `(crontab -l 2>/dev/null | grep -v certbot; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | crontab -`,
      'Настройка auto-renew cron'
    );

    // Шаг 8: Финальная проверка
    await exec(conn, 'systemctl status nginx --no-pager | head -5', 'Финальный статус nginx');
    await exec(conn, `curl -s -o /dev/null -w "HTTP: %{http_code} | SSL verify: %{ssl_verify_result}\\n" https://${DOMAIN}/ --max-time 10 2>&1 || echo "curl https failed"`, 'HTTPS проверка');
    await exec(conn, `curl -s -o /dev/null -w "HTTP port 80: %{http_code}\\n" http://${DOMAIN}/ --max-time 10 2>&1 || echo "curl http failed"`, 'HTTP→HTTPS редирект');

    console.log(`\n🎉 Готово! https://${DOMAIN}`);
    console.log('⚠️  Не забудьте сменить root-пароль: команда `passwd` на сервере!');

  } catch(e) {
    console.error('\n❌ Ошибка:', e.message);
  } finally {
    conn.end();
  }
}

main().catch(console.error);
