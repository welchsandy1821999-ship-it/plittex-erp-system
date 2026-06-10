#!/usr/bin/env node
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

// Дефолтный блок — перехватывает ВСЕ запросы к неизвестным доменам
// и возвращает 444 (nginx сразу закрывает соединение, ничего не отдаёт)
const DEFAULT_CONF = `# Дефолтный блок — для неизвестных доменов
# Попадает сюда всё что НЕ erp.plittex.ru
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}

server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;

    ssl_certificate /etc/letsencrypt/live/erp.plittex.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/erp.plittex.ru/privkey.pem;

    return 444;
}
`;

async function main() {
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve); conn.on('error', reject);
    conn.connect({ host: '159.194.207.6', username: 'root', password: '+JjJWwaK5+6b', port: 22 });
  });
  console.log('✅ Connected\n');

  try {
    // Убираем default из sites-enabled (он может конфликтовать)
    await exec(conn, 'rm -f /etc/nginx/sites-enabled/default', 'Удаляем дефолтный конфиг Beget');

    // Пишем наш дефолтный блок
    await sftpWrite(conn, '/etc/nginx/sites-available/default_catch', DEFAULT_CONF);
    await exec(conn, 'ln -sf /etc/nginx/sites-available/default_catch /etc/nginx/sites-enabled/default_catch', 'Включаем default_catch');

    // Проверяем и перезагружаем
    await exec(conn, 'nginx -t', 'Проверка nginx');
    await exec(conn, 'systemctl reload nginx && echo "nginx OK"', 'Перезагрузка nginx');

    // Итог — список конфигов
    await exec(conn, 'ls /etc/nginx/sites-enabled/', 'Активные конфиги');

    // Проверяем: plittex.ru теперь должен вернуть пустой ответ
    await exec(conn, 'curl -sv http://plittex.ru/ --resolve "plittex.ru:80:159.194.207.6" --max-time 5 2>&1 | grep -E "Empty|444|Connected|HTTP|reset|close"', 'Тест: plittex.ru на нашем VPS');
    // Проверяем: erp.plittex.ru работает
    await exec(conn, 'curl -s -o /dev/null -w "erp.plittex.ru HTTPS: %{http_code}\\n" https://erp.plittex.ru/ --max-time 10', 'Тест: erp.plittex.ru');

    console.log('\n✅ Готово!');
    console.log('  Теперь только erp.plittex.ru обслуживается на этом VPS.');
    console.log('  Все другие домены (plittex.ru и т.д.) получают 444 — не попадают в ERP.');
    console.log('\n  ⏳ Дождитесь обновления DNS (10-30 мин) — plittex.ru откроет сайт с Beget хостинга.');

  } catch (e) {
    console.error('\n❌ Ошибка:', e.message);
  } finally {
    conn.end();
  }
}

main().catch(console.error);
