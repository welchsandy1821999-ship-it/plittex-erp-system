#!/usr/bin/env node
const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', async () => {
  const run = (cmd, desc) => new Promise(resolve => {
    if (desc) console.log(`\n[→] ${desc}`);
    conn.exec(cmd, (err, stream) => {
      if (err) { console.error(err); return resolve(''); }
      let out = '';
      stream.on('data', d => { process.stdout.write(d.toString()); out += d; });
      stream.stderr.on('data', d => { process.stdout.write(d.toString()); out += d; });
      stream.on('close', code => { if(code) console.log(`[exit: ${code}]`); resolve(out); });
    });
  });

  console.log('✅ Connected\n');

  // Проблема: два конфига конфликтуют. 
  // plittex-erp — правильный (с SSL от certbot)
  // erp.plittex.ru — наш HTTP-only конфиг (лишний)
  // Решение: удалить наш HTTP конфиг, оставить только plittex-erp

  await run('ls /etc/nginx/sites-enabled/', 'Текущие конфиги');

  // Удаляем конфликтующий HTTP-only конфиг
  await run(
    'rm -f /etc/nginx/sites-enabled/erp.plittex.ru /etc/nginx/sites-available/erp.plittex.ru',
    'Удаление лишнего HTTP конфига'
  );

  // Убеждаемся что plittex-erp конфиг правильный
  await run('cat /etc/nginx/sites-available/plittex-erp', 'Проверка основного конфига');

  // Проверяем nginx
  await run('nginx -t', 'Проверка конфига');

  // Перезапускаем nginx
  await run('systemctl reload nginx && echo "nginx reloaded OK"', 'Перезагрузка nginx');

  // Финальная проверка
  await run('nginx -T 2>/dev/null | grep -E "server_name|listen|ssl_cert" | head -20', 'Активные правила nginx');
  
  await run(
    'curl -sv https://erp.plittex.ru/ --max-time 10 2>&1 | grep -E "SSL connection|subject|HTTP/|< HTTP|Connected|TLSv"',
    'HTTPS тест'
  );

  await run(
    'curl -sv http://erp.plittex.ru/ --max-time 10 2>&1 | grep -E "location|HTTP/|< HTTP|301|302"',
    'HTTP→HTTPS редирект тест'
  );

  console.log('\n✅ Готово! Попробуйте открыть https://erp.plittex.ru на iPhone');
  conn.end();
}).connect({ host: '159.194.207.6', username: 'root', password: '+JjJWwaK5+6b', port: 22 });
