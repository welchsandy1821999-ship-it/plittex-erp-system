#!/usr/bin/env node
/**
 * Добавляем только plittex.ru (без www — он на другом сервере)
 */

const { Client } = require('ssh2');
const conn = new Client();

function exec(conn, cmd, desc) {
  return new Promise((resolve, reject) => {
    if (desc) console.log(`\n[→] ${desc}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', d => { process.stdout.write(d.toString()); out += d.toString(); });
      stream.stderr.on('data', d => { process.stdout.write(d.toString()); out += d.toString(); });
      stream.on('close', code => { if (code !== 0) console.log(`[exit: ${code}]`); resolve({ code, out }); });
    });
  });
}

function sftpWrite(conn, remotePath, content) {
  return new Promise((resolve, reject) => {
    console.log(`\n[SFTP] Запись ${remotePath}`);
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const s = sftp.createWriteStream(remotePath);
      s.on('close', () => { console.log('[SFTP] Готово.'); sftp.end(); resolve(); });
      s.on('error', reject);
      s.write(content); s.end();
    });
  });
}

// nginx конфиг для plittex.ru — редирект на erp.plittex.ru
const PLITTEX_NGINX = `server {
    listen 80;
    listen [::]:80;
    server_name plittex.ru;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://erp.plittex.ru$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name plittex.ru;

    ssl_certificate /etc/letsencrypt/live/erp.plittex.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/erp.plittex.ru/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        return 301 https://erp.plittex.ru$request_uri;
    }
}
`;

async function main() {
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve); conn.on('error', reject);
    conn.connect({ host: '159.194.207.6', username: 'root', password: '+JjJWwaK5+6b', port: 22 });
  });
  console.log('✅ SSH подключён\n');

  try {
    // Проверяем DNS
    await exec(conn, 'dig plittex.ru +short 2>/dev/null; dig www.plittex.ru +short 2>/dev/null', 'DNS проверка');

    // Шаг 1: Сначала создаём nginx конфиг для plittex.ru (только HTTP)
    // чтобы certbot мог пройти ACME challenge
    const HTTP_ONLY = `server {
    listen 80;
    listen [::]:80;
    server_name plittex.ru;
    root /var/www/html;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://erp.plittex.ru$request_uri; }
}
`;
    await sftpWrite(conn, '/etc/nginx/sites-available/plittex', HTTP_ONLY);
    await exec(conn, 'ln -sf /etc/nginx/sites-available/plittex /etc/nginx/sites-enabled/plittex', 'Включаем HTTP конфиг');
    await exec(conn, 'nginx -t && systemctl reload nginx', 'Перезагружаем nginx');

    // Шаг 2: Расширяем сертификат — только plittex.ru, без www
    const cert = await exec(conn,
      'certbot certonly --webroot -w /var/www/html ' +
      '--cert-name erp.plittex.ru ' +
      '-d erp.plittex.ru -d plittex.ru ' +
      '--non-interactive --agree-tos --email admin@plittex.ru 2>&1',
      'certbot: добавляем plittex.ru к сертификату'
    );

    if (cert.code === 0) {
      console.log('\n✅ Сертификат расширен — покрывает erp.plittex.ru + plittex.ru');

      // Шаг 3: Пишем полный конфиг с SSL
      await sftpWrite(conn, '/etc/nginx/sites-available/plittex', PLITTEX_NGINX);
      await exec(conn, 'nginx -t && systemctl reload nginx', 'Перезагружаем nginx с SSL');

      // Финальная проверка
      await exec(conn,
        'openssl s_client -connect plittex.ru:443 -servername plittex.ru < /dev/null 2>/dev/null | openssl x509 -noout -subject -subjectAltName',
        'Итоговый сертификат'
      );
      await exec(conn,
        'curl -s -o /dev/null -w "plittex.ru HTTPS: %{http_code}\\n" https://plittex.ru/ --max-time 10',
        'HTTPS тест'
      );

      console.log('\n🎉 Готово!');
      console.log('  https://plittex.ru    → 301 → https://erp.plittex.ru');
      console.log('  http://plittex.ru     → 301 → https://erp.plittex.ru');
      console.log('\n  www.plittex.ru — на другом сервере (45.130.41.113), нужно настроить отдельно.');

    } else {
      console.log('\n❌ certbot не смог добавить plittex.ru');
      console.log('Проверьте что plittex.ru → 159.194.207.6 в DNS панели домена.');
      await exec(conn, 'cat /var/log/letsencrypt/letsencrypt.log | tail -30', 'certbot лог');
    }

  } catch (e) {
    console.error('\n❌ Ошибка:', e.message);
  } finally {
    conn.end();
  }
}

main().catch(console.error);
