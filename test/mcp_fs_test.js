// test/mcp_fs_test.js
const { spawn } = require('child_process');
const server = spawn('cmd', ['/c', 'npx', '-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\Пользователь\\Desktop\\plittex-erp']);

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
        console.log('File content:', resp.result);
        server.kill();
      }
    } catch (e) {}
  });
});

server.stderr.on('data', data => console.error('Server error:', data.toString()));

// Request to read package.json
send('readFile', { path: 'package.json' });
