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
      stream.on('close', code => { if(code) console.log(`[exit:${code}]`); resolve(out); });
    });
  });

  console.log('✅ Connected\n');

  // Удаляем все конфиги для plittex.ru (они не нужны — сайт на Beget хостинге)
  await run('ls /etc/nginx/sites-enabled/ && ls /etc/nginx/sites-available/', 'Текущие конфиги');
  await run('rm -f /etc/nginx/sites-enabled/plittex /etc/nginx/sites-available/plittex', 'Удаляем plittex конфиг');
  await run('nginx -t', 'Проверка nginx');
  await run('systemctl reload nginx && echo "OK"', 'Перезагрузка nginx');
  await run('ls /etc/nginx/sites-enabled/', 'Оставшиеся конфиги');
  
  console.log('\n✅ Готово! Теперь VPS знает только про erp.plittex.ru');
  console.log('   plittex.ru теперь полностью обслуживается Beget хостингом.');
  conn.end();
}).connect({ host: '159.194.207.6', username: 'root', password: '+JjJWwaK5+6b', port: 22 });
