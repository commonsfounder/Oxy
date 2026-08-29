const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const app = require('../../api/index');

function postJson(server, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST', hostname: '127.0.0.1', port: server.address().port, path,
      headers: { 'Content-Type': 'application/json', ...headers }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test('POST /millie/provision without auth is rejected', async () => {
  const server = app.listen(0);
  try {
    const res = await postJson(server, '/millie/provision', {});
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
