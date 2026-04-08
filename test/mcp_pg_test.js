// test/mcp_pg_test.js
const { spawn } = require('child_process');
const server = spawn('node', ['./node_modules/@modelcontextprotocol/server-postgres/dist/index.js', 'postgres://postgres:Plittex_2026_SQL@localhost:5432/plittex_erp']);

let requestId = 1;
function send(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: requestId++, method, params });
  server.stdin.write(payload + '\n');
}

server.stdout.on('data', data => {
  const lines = data.toString().trim().split('\n');
  lines.forEach(line => {
    try {
      const resp = JSON.parse(line);
      if (resp.result) {
        console.log('Query result:', resp.result);
        server.kill();
      }
    } catch (e) {}
  });
});

server.stderr.on('data', data => console.error('Server error:', data.toString()));

// Request simple query
send('query', { sql: 'SELECT 1;' });
