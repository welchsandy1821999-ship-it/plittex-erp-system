// test/mcp_puppeteer_test.js
const { spawn } = require('child_process');
const path = require('path');
const server = spawn('npx.cmd', ['-y', '@modelcontextprotocol/server-puppeteer', '--headless']);

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
      if (resp.result && resp.result.screenshotPath) {
        console.log('Screenshot saved to', resp.result.screenshotPath);
        server.kill();
      }
    } catch (e) {}
  });
});

server.stderr.on('data', data => console.error('Server error:', data.toString()));

// Open page and take screenshot
send('screenshot', { url: 'http://localhost:3000', path: path.join(__dirname, '..', 'tmp', 'home.png') });
