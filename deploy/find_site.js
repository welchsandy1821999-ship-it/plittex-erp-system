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

  // Ищем сайт plittex.ru на сервере
  await run('find / -name "index.html" -not -path "*/proc/*" -not -path "*/sys/*" -not -path "*/letsencrypt/*" 2>/dev/null | head -20', 'Поиск index.html на сервере');
  await run('ls /var/www/ 2>/dev/null', '/var/www содержимое');
  await run('ls /home/ 2>/dev/null', '/home содержимое');
  await run('ls /root/ 2>/dev/null', '/root содержимое');
  await run('pm2 list 2>/dev/null', 'PM2 процессы');

  conn.end();
}).connect({ host: '159.194.207.6', username: 'root', password: '+JjJWwaK5+6b', port: 22 });
