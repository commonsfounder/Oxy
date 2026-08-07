const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const app = require('../../api/index');

function postJson(server, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'POST', hostname: '127.0.0.1', port: server.address().port, path, headers: { 'Content-Type': 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test('POST /webhooks/millie-email with no matching Millie address returns 200 and does nothing destructive', async () => {
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/webhooks/millie-email', {
      data: { from: 'nobody@example.com', to: ['unclaimed@millie.oxy.app'], subject: 'hi', text: 'hello', email_id: 'evt-1' }
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});
