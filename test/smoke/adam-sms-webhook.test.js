const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const app = require('../../api/index');

test('POST /webhooks/millie-sms with no matching Adam number returns 200', async () => {
  const server = app.listen(0);
  try {
    const body = new URLSearchParams({ From: '+15559876543', To: '+15550000000', Body: 'hi', MessageSid: 'SMtest' });
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        method: 'POST', hostname: '127.0.0.1', port: server.address().port, path: '/webhooks/millie-sms',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, res => { let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, data })); });
      req.on('error', reject);
      req.write(body.toString());
      req.end();
    });
    assert.equal(result.status, 200);
  } finally {
    server.close();
  }
});
