#!/usr/bin/env node
/**
 * Добавляем plittex.ru и www.plittex.ru в SSL-сертификат
 * и создаём nginx-конфиг для основного сайта
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
      stream.on('close', code => {
        if (code !== 0) console.log(`[exit: ${code}]`);
        resolve({ code, out });
      });
    });
  });
}

function sftpWrite(conn, remotePath, content) {
  return new Promise((resolve, reject) => {
    console.log(`\n[SFTP] Запись ${remotePath}`);
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', () => { console.log('[SFTP] Готово.'); sftp.end(); resolve(); });
      stream.on('error', reject);
      stream.write(content);
      stream.end();
    });
  });
}

// nginx конфиг для plittex.ru — редирект на erp.plittex.ru
// (основной сайт = ERP, или можно раздавать статику)
const PLITTEX_NGINX = `# plittex.ru → erp.plittex.ru
server {
    listen 80;
    listen [::]:80;
    server_name plittex.ru www.plittex.ru;

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
    server_name plittex.ru www.plittex.ru;

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
    conn.on('ready', resolve);
    conn.on('error', reject);
    conn.connect({ host: '159.194.207.6', username: 'root', password: '+JjJWwaK5+6b', port: 22, readyTimeout: 15000 });
  });

  console.log('✅ SSH подключён\n');

  try {
    // Шаг 1: Расширяем сертификат — добавляем plittex.ru и www.plittex.ru
    console.log('\n[→] Расширяем SSL-сертификат на plittex.ru и www.plittex.ru...');
    const certExpand = await exec(conn,
      'certbot certonly --nginx --cert-name erp.plittex.ru ' +
      '-d erp.plittex.ru -d plittex.ru -d www.plittex.ru ' +
      '--non-interactive --agree-tos --email admin@plittex.ru 2>&1',
      'certbot expand (добавляем домены)'
    );

    if (certExpand.code === 0) {
      console.log('\n✅ Сертификат расширен — теперь покрывает erp.plittex.ru + plittex.ru + www.plittex.ru');
    } else {
      console.log('\n[!] certbot --nginx не сработал, пробуем --webroot...');
      await exec(conn, 'mkdir -p /var/www/html/.well-known/acme-challenge', 'Создаём webroot');
      const certWebroot = await exec(conn,
        'certbot certonly --webroot -w /var/www/html --cert-name erp.plittex.ru ' +
        '-d erp.plittex.ru -d plittex.ru -d www.plittex.ru ' +
        '--non-interactive --agree-tos --email admin@plittex.ru 2>&1',
        'certbot --webroot'
      );
      if (certWebroot.code !== 0) {
        console.log('\n❌ certbot не смог расширить сертификат.');
        console.log('Возможно plittex.ru или www.plittex.ru не направлены на этот сервер.');
        conn.end();
        return;
      }
    }

    // Шаг 2: Создаём nginx конфиг для plittex.ru
    await sftpWrite(conn, '/etc/nginx/sites-available/plittex', PLITTEX_NGINX);
    await exec(conn,
      'ln -sf /etc/nginx/sites-available/plittex /etc/nginx/sites-enabled/plittex',
      'Включаем конфиг plittex'
    );

    // Шаг 3: Проверяем и перезагружаем nginx
    await exec(conn, 'nginx -t', 'Проверка nginx');
    await exec(conn, 'systemctl reload nginx && echo "nginx OK"', 'Перезагрузка nginx');

    // Шаг 4: Финальная проверка
    await exec(conn,
      'curl -sv https://plittex.ru/ --max-time 10 2>&1 | grep -E "subject|subjectAlt|HTTP/|SSL conn|error"',
      'Проверка HTTPS plittex.ru'
    );
    await exec(conn,
      'curl -sv https://www.plittex.ru/ --max-time 10 2>&1 | grep -E "subject|subjectAlt|HTTP/|SSL conn|error"',
      'Проверка HTTPS www.plittex.ru'
    );

    // Показываем итоговый сертификат
    await exec(conn,
      'openssl s_client -connect plittex.ru:443 -servername plittex.ru < /dev/null 2>/dev/null | openssl x509 -noout -subject -subjectAltName',
      'Итоговый сертификат'
    );

    console.log('\n🎉 Готово!');
    console.log('  https://plittex.ru      → редирект на https://erp.plittex.ru');
    console.log('  https://www.plittex.ru  → редирект на https://erp.plittex.ru');
    console.log('  https://erp.plittex.ru  → ERP система');

  } catch (e) {
    console.error('\n❌ Ошибка:', e.message);
  } finally {
    conn.end();
  }
}

main().catch(console.error);
