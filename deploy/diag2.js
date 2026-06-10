#!/usr/bin/env node
const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', async () => {
  const run = (cmd, desc) => new Promise(resolve => {
    if (desc) console.log(`\n=== ${desc} ===`);
    conn.exec(cmd, (err, stream) => {
      if (err) { console.error(err); return resolve(''); }
      let out = '';
      stream.on('data', d => { process.stdout.write(d.toString()); out += d; });
      stream.stderr.on('data', d => { process.stdout.write(d.toString()); out += d; });
      stream.on('close', () => resolve(out));
    });
  });

  console.log('✅ Connected\n');

  await run('ls /etc/nginx/sites-enabled/', 'Все конфиги nginx');
  await run('cat /etc/nginx/sites-available/plittex-erp', 'plittex-erp конфиг');
  
  // Проверяем все сертификаты
  await run('ls /etc/letsencrypt/live/', 'Все сертификаты Let\'s Encrypt');
  
  // Проверяем что отдаёт plittex.ru
  await run('curl -sv https://plittex.ru/ --max-time 10 2>&1 | grep -E "subject|subjectAlt|SSL|Connected|TLS|HTTP"', 'SSL cert для plittex.ru');
  
  // Какой IP у plittex.ru?
  await run('dig plittex.ru +short 2>/dev/null || nslookup plittex.ru 8.8.8.8 2>/dev/null | grep Address | tail -1', 'DNS plittex.ru');
  await run('dig erp.plittex.ru +short 2>/dev/null || nslookup erp.plittex.ru 8.8.8.8 2>/dev/null | grep Address | tail -1', 'DNS erp.plittex.ru');
  
  // Все nginx конфиги с server_name
  await run('grep -r "server_name" /etc/nginx/sites-available/ /etc/nginx/sites-enabled/ 2>/dev/null', 'Все server_name в конфигах');

  conn.end();
}).connect({ host: '159.194.207.6', username: 'root', password: '+JjJWwaK5+6b', port: 22 });
