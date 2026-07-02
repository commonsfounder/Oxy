'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { shouldUseRemoteForHost } = require('../../api/services/browser-task');

const EP = 'wss://example-managed-browser:9222';

test('never uses remote when no endpoint is configured (today\'s default)', () => {
  assert.equal(shouldUseRemoteForHost('next.co.uk', {}), false);
  assert.equal(shouldUseRemoteForHost('johnlewis.com', { BROWSER_REMOTE_HOSTS: 'next.co.uk' }), false);
});

test('with an endpoint, routes the default bot-wall hosts to remote and leaves others local', () => {
  const env = { BROWSER_REMOTE_ENDPOINT: EP };
  // walled → remote
  assert.equal(shouldUseRemoteForHost('next.co.uk', env), true);
  assert.equal(shouldUseRemoteForHost('argos.co.uk', env), true);
  assert.equal(shouldUseRemoteForHost('just-eat.co.uk', env), true);
  // working-on-datacenter-IP → stays local (free): John Lewis, Tesco, Zara all passed the benchmark
  assert.equal(shouldUseRemoteForHost('johnlewis.com', env), false);
  assert.equal(shouldUseRemoteForHost('tesco.com', env), false);
  assert.equal(shouldUseRemoteForHost('zara.com', env), false);
});

test('www. and subdomains of a walled host still route remote', () => {
  const env = { BROWSER_REMOTE_ENDPOINT: EP };
  assert.equal(shouldUseRemoteForHost('www.next.co.uk', env), true);
  assert.equal(shouldUseRemoteForHost('shop.hm.com', env), true);
});

test('BROWSER_REMOTE_ALWAYS routes every host through the managed browser', () => {
  const env = { BROWSER_REMOTE_ENDPOINT: EP, BROWSER_REMOTE_ALWAYS: 'true' };
  assert.equal(shouldUseRemoteForHost('johnlewis.com', env), true);
  assert.equal(shouldUseRemoteForHost('anything.example', env), true);
});

test('BROWSER_REMOTE_HOSTS overrides the default set wholesale', () => {
  const env = { BROWSER_REMOTE_ENDPOINT: EP, BROWSER_REMOTE_HOSTS: 'boots.com, superdrug.com' };
  assert.equal(shouldUseRemoteForHost('boots.com', env), true);
  assert.equal(shouldUseRemoteForHost('superdrug.com', env), true);
  // a default-list host is NOT remote once you supply your own list
  assert.equal(shouldUseRemoteForHost('next.co.uk', env), false);
});

test('tolerates missing/garbage host', () => {
  const env = { BROWSER_REMOTE_ENDPOINT: EP };
  assert.equal(shouldUseRemoteForHost('', env), false);
  assert.equal(shouldUseRemoteForHost(null, env), false);
  assert.equal(shouldUseRemoteForHost(undefined, env), false);
});
