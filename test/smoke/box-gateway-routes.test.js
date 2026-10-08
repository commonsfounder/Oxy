const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-session-secret';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';

const app = require('../../api/index');
let server;
let port;

test.before(async () => {
  server = await new Promise(resolve => { const instance = app.listen(0, () => resolve(instance)); });
  port = server.address().port;
});

test.after(async () => { await new Promise(resolve => server.close(resolve)); });

function post(path, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: 'POST', headers: { 'content-type': contentType, authorization: 'Bearer not-a-real-token' } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// The app-wide login check must let the box's token-scoped routes through to their own display check.
test('the box routes are reached by the real server and refuse a bad display token themselves', async () => {
  for (const [route, body, type] of [['voice', Buffer.alloc(40000), 'application/octet-stream'], ['sensors', '{}', 'application/json'], ['sound', '{"type":"smoke_alarm"}', 'application/json'], ['signal', '{"kind":"sensor","name":"motion","value":"active"}', 'application/json']]) {
    const result = await post(`/display/some-display/${route}`, body, type);
    assert.notEqual(result.status, 404, route);
    assert.notEqual(JSON.parse(result.text).error, 'Unauthorized', `${route} was stopped by the app login check`);
    assert.ok([401, 503].includes(result.status), `${route} returned ${result.status}`);
  }
});
