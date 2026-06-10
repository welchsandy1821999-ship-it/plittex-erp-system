#!/usr/bin/env node
/**
 * Загружаем собранный сайт plittex.ru на сервер через SFTP
 * и настраиваем nginx для его раздачи
 */

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const REMOTE_HOST = '159.194.207.6';
const REMOTE_USER = 'root';
const REMOTE_PASS = '+JjJWwaK5+6b';
const LOCAL_DIST = path.join(__dirname, '..', '..', 'plittex-v2', 'dist-deploy');
const REMOTE_DIR = '/var/www/plittex';

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

function getSftp(conn) {
  return new Promise((resolve, reject) => conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp)));
}

async function uploadDir(sftp, localDir, remoteDir) {
  const entries = fs.readdirSync(localDir);
  for (const entry of entries) {
    const localPath = path.join(localDir, entry);
    const remotePath = remoteDir + '/' + entry;
    const stat = fs.statSync(localPath);
    if (stat.isDirectory()) {
      // Создаём директорию на сервере
      await new Promise((resolve) => sftp.mkdir(remotePath, () => resolve())); // игнорируем ошибку если уже есть
      await uploadDir(sftp, localPath, remotePath);
    } else {
      // Загружаем файл
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(localPath);
        const writeStream = sftp.createWriteStream(remotePath);
        writeStream.on('close', resolve);
        writeStream.on('error', reject);
        readStream.pipe(writeStream);
      });
      process.stdout.write('.');
    }
  }
}

function sftpWrite(conn, remotePath, content) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const s = sftp.createWriteStream(remotePath);
      s.on('close', () => { sftp.end(); resolve(); });
      s.on('error', reject);
      s.write(content); s.end();
    });
  });
}

const NGINX_PLITTEX = `server {
    listen 80;
    listen [::]:80;
    server_name plittex.ru www.plittex.ru;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://plittex.ru$request_uri;
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

    root /var/www/plittex;
    index index.html;

    client_max_body_size 50M;

    # SPA / многостраничный сайт
    location / {
        try_files $uri $uri/ $uri.html =404;
    }

    # Кеширование статики
    location ~* \\.(js|css|png|jpg|jpeg|webp|woff2|woff|ico|svg|mp4)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }

    # PHP файлы (если есть send.php и т.д.)
    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/var/run/php/php-fpm.sock;
    }
}
`;

async function main() {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve); conn.on('error', reject);
    conn.connect({ host: REMOTE_HOST, username: REMOTE_USER, password: REMOTE_PASS, port: 22 });
  });
  console.log('✅ SSH подключён\n');

  try {
    // 1. Создаём директорию для сайта
    await exec(conn, `mkdir -p ${REMOTE_DIR}`, `Создаём ${REMOTE_DIR}`);

    // 2. Загружаем файлы
    console.log(`\n[→] Загружаем файлы из ${LOCAL_DIST} → ${REMOTE_DIR}`);
    const sftp = await getSftp(conn);
    await uploadDir(sftp, LOCAL_DIST, REMOTE_DIR);
    sftp.end();
    console.log('\n[→] Загрузка завершена!');

    // 3. Проверяем что файлы на месте
    await exec(conn, `ls ${REMOTE_DIR} | head -20`, 'Файлы на сервере');

    // 4. Если есть PHP-файлы — устанавливаем php-fpm
    const hasPHP = fs.existsSync(path.join(LOCAL_DIST, 'send.php'));
    if (hasPHP) {
      console.log('\n[→] Обнаружены PHP-файлы — проверяем php-fpm...');
      await exec(conn, 'which php-fpm8.3 2>/dev/null || which php-fpm 2>/dev/null || apt-get install -y php8.3-fpm -qq && systemctl start php8.3-fpm', 'PHP-FPM');
    }

    // 5. Nginx конфиг для plittex.ru
    await sftpWrite(conn, '/etc/nginx/sites-available/plittex', NGINX_PLITTEX);
    await exec(conn, 'ln -sf /etc/nginx/sites-available/plittex /etc/nginx/sites-enabled/plittex', 'Включаем конфиг');
    
    // 6. Проверка и перезагрузка
    const test = await exec(conn, 'nginx -t', 'Проверка nginx');
    if (test.code === 0) {
      await exec(conn, 'systemctl reload nginx', 'Перезагрузка nginx');
      console.log('\n✅ nginx перезагружен!');
    }

    // 7. Права на файлы
    await exec(conn, `chown -R www-data:www-data ${REMOTE_DIR} && chmod -R 755 ${REMOTE_DIR}`, 'Права на файлы');

    // 8. Финальная проверка
    await exec(conn, `curl -s -o /dev/null -w "plittex.ru HTTP: %{http_code}\\n" https://plittex.ru/ --max-time 10`, 'HTTPS тест');

    console.log('\n🎉 Готово!');
    console.log('  https://plittex.ru     → сайт компании');
    console.log('  https://erp.plittex.ru → ERP система');

  } catch (e) {
    console.error('\n❌ Ошибка:', e.message);
  } finally {
    conn.end();
  }
}

main().catch(console.error);
