const test = require('node:test');
const assert = require('node:assert');
const { resolveClientIp, isCloudflareAddress } = require('../../api/services/client-ip');

test('recognises Cloudflare addresses and nothing else', () => {
  assert.strictEqual(isCloudflareAddress('172.67.10.1'), true);
  assert.strictEqual(isCloudflareAddress('104.21.5.5'), true);
  assert.strictEqual(isCloudflareAddress('2606:4700:3030::1'), true);
  assert.strictEqual(isCloudflareAddress('203.0.113.9'), false);
  assert.strictEqual(isCloudflareAddress('not an ip'), false);
});

test('off by default: the visitor header is ignored', () => {
  const headers = { 'fly-client-ip': '172.67.10.1', 'cf-connecting-ip': '81.2.69.142' };
  assert.strictEqual(resolveClientIp(headers), '172.67.10.1');
});

test('on: the visitor address is believed only when the connection came from Cloudflare', () => {
  const opts = { trustCloudflare: true };
  assert.strictEqual(resolveClientIp({ 'fly-client-ip': '172.67.10.1', 'cf-connecting-ip': '81.2.69.142' }, opts), '81.2.69.142');
  // Someone hitting Fly directly and forging the header gains nothing.
  assert.strictEqual(resolveClientIp({ 'fly-client-ip': '203.0.113.9', 'cf-connecting-ip': '1.2.3.4' }, opts), '203.0.113.9');
  assert.strictEqual(resolveClientIp({ 'fly-client-ip': '172.67.10.1', 'cf-connecting-ip': 'garbage' }, opts), '172.67.10.1');
});
