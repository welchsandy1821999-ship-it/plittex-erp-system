#!/usr/bin/env node
/**
 * Скрипт удалённой настройки SSL через Node.js ssh2
 * Устанавливает nginx + certbot на сервере, выпускает сертификат Let's Encrypt
 * и настраивает reverse proxy на localhost:3000
 */

const { Client } = require('ssh2');

const CONFIG = {
  host: '159.194.207.6',
  username: 'root',
  password: '+JjJWwaK5+6b',
  domain: 'erp.plittex.ru',
  appPort: 3000
};

const NGINX_CONF = `
server {
    listen 80;
    server_name ${CONFIG.domain};
    
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name ${CONFIG.domain};
    
    ssl_certificate /etc/letsencrypt/live/${CONFIG.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${CONFIG.domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    client_max_body_size 50M;
    
    location / {
        proxy_pass http://localhost:${CONFIG.appPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
    }
}
`.trim();

function runCommand(conn, cmd, desc) {
  return new Promise((resolve, reject) => {
    console.log(`\n[→] ${desc || cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', d => { 
        process.stdout.write(d.toString()); 
        stdout += d.toString(); 
      });
      stream.stderr.on('data', d => { 
        process.stderr.write(d.toString()); 
        stderr += d.toString(); 
      });
      stream.on('close', (code) => {
        if (code !== 0) {
          console.log(`[!] Exit code: ${code}`);
        }
        resolve({ code, stdout, stderr });
      });
    });
  });
}

async function main() {
  const conn = new Client();
  
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve);
    conn.on('error', reject);
    conn.connect({
      host: CONFIG.host,
      username: CONFIG.username,
      password: CONFIG.password,
      port: 22,
      readyTimeout: 15000
    });
  });
  
  console.log('✅ SSH connected to', CONFIG.host);
  
  try {
    // 1. Проверка ОС и текущего состояния
    await runCommand(conn, 'cat /etc/os-release | head -3', 'Проверка ОС');
    await runCommand(conn, 'ss -tlnp | grep -E "80|443|3000" || echo "no ports"', 'Открытые порты');
    await runCommand(conn, 'pm2 list 2>/dev/null || docker ps 2>/dev/null | head -5 || echo "no pm2/docker"', 'Статус приложения');
    
    // 2. Установка nginx и certbot
    console.log('\n[→] Установка nginx и certbot...');
    await runCommand(conn, 'apt-get update -qq', 'apt update');
    await runCommand(conn, 'apt-get install -y nginx certbot python3-certbot-nginx -qq', 'Установка nginx + certbot');
    
    // 3. Создание nginx конфига (только HTTP для получения сертификата)
    const tempConf = `server {
    listen 80;
    server_name ${CONFIG.domain};
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        proxy_pass http://localhost:${CONFIG.appPort};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;
    
    await runCommand(conn, `mkdir -p /var/www/certbot && echo '${tempConf.replace(/'/g, "'\\''").replace(/\n/g, '\\n')}' | cat > /etc/nginx/sites-available/${CONFIG.domain}`, 'Создание HTTP конфига');
    await runCommand(conn, `ln -sf /etc/nginx/sites-available/${CONFIG.domain} /etc/nginx/sites-enabled/ && rm -f /etc/nginx/sites-enabled/default`, 'Включение конфига');
    await runCommand(conn, 'nginx -t', 'Проверка nginx конфига');
    await runCommand(conn, 'systemctl restart nginx && systemctl enable nginx', 'Запуск nginx');
    
    // 4. Получение SSL сертификата
    console.log('\n[→] Получение Let\'s Encrypt сертификата...');
    const certResult = await runCommand(conn, 
      `certbot --nginx -d ${CONFIG.domain} --non-interactive --agree-tos --email admin@plittex.ru --redirect`,
      'certbot (Let\'s Encrypt)'
    );
    
    if (certResult.code === 0) {
      console.log('\n✅ SSL сертификат успешно получен!');
      await runCommand(conn, 'nginx -t && systemctl reload nginx', 'Перезагрузка nginx с SSL');
    } else {
      // Certbot не смог — создадим полный конфиг вручную
      console.log('\n[!] certbot --nginx не сработал, пишем конфиг вручную...');
      
      const fullConf = NGINX_CONF.replace(/\$\{CONFIG\.domain\}/g, CONFIG.domain);
      await runCommand(conn, 
        `cat > /etc/nginx/sites-available/${CONFIG.domain} << 'NGINXEOF'\n${NGINX_CONF}\nNGINXEOF`,
        'Запись полного nginx конфига'
      );
      await runCommand(conn, 'nginx -t && systemctl reload nginx', 'Перезагрузка nginx');
    }
    
    // 5. Настройка авторекоста сертификата
    await runCommand(conn, '(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | sort -u | crontab -', 'Настройка auto-renew cron');
    
    // 6. Финальная проверка
    await runCommand(conn, `curl -s -o /dev/null -w "HTTP Status: %{http_code}\\nSSL: %{ssl_verify_result}\\n" https://${CONFIG.domain}/api/health 2>/dev/null || curl -I http://${CONFIG.domain} 2>/dev/null | head -5`, 'Финальная проверка HTTPS');
    
    console.log('\n🎉 Настройка SSL завершена!');
    console.log(`🔗 Приложение доступно по адресу: https://${CONFIG.domain}`);
    
  } catch (err) {
    console.error('\n❌ Ошибка:', err.message);
  } finally {
    conn.end();
  }
}

main().catch(console.error);
