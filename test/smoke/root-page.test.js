const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const app = require('../../api/index');

function get(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, path }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });
}

test('the public root answers with a page that links the legal pages', async () => {
  const server = app.listen(0);
  try {
    const res = await get(server, '/');
    assert.equal(res.status, 200);
    assert.match(res.type, /text\/html/);
    for (const link of ['/privacy', '/terms', '/support']) assert.ok(res.body.includes(`href="${link}"`), link);
  } finally {
    server.close();
  }
});
