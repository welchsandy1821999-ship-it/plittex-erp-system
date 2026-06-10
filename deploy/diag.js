#!/usr/bin/env node
const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', async () => {
  console.log('Connected\n');
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

  await run('ls -la /etc/nginx/sites-enabled/', 'sites-enabled');
  await run('ls -la /etc/nginx/sites-available/', 'sites-available');
  await run('cat /etc/nginx/sites-enabled/plittex-erp 2>/dev/null || echo "file not found"', 'plittex-erp config');
  await run('cat /etc/nginx/sites-enabled/erp.plittex.ru 2>/dev/null || echo "file not found"', 'erp.plittex.ru config');
  await run('ls /etc/letsencrypt/live/ 2>/dev/null', 'letsencrypt certs');
  await run('openssl s_client -connect erp.plittex.ru:443 -servername erp.plittex.ru < /dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null || echo "openssl check failed"', 'SSL cert info');
  await run('curl -sv https://erp.plittex.ru/ --max-time 5 2>&1 | head -30', 'curl verbose https');

  conn.end();
}).connect({ host: '159.194.207.6', username: 'root', password: '+JjJWwaK5+6b', port: 22 });
