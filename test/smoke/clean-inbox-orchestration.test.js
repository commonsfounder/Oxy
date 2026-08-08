// Full clean_inbox orchestration: search -> classify (real emailTriageSignals) -> bulk
// archive -> per-sender unsubscribe -> truthful summary (api/index.js's clean_inbox case).
// Mocks only the outermost I/O boundary — connectors/index.js's dispatch registry — so the
// REAL orchestration code in api/index.js and the REAL classification logic in
// gmail-cleanup.js/emailTriageSignals both run for real. The Gmail HTTP layer itself
// (archive_emails/label_emails/unsubscribe_email against real API semantics) is covered
// separately in gmail-cleanup-mutations.test.js — this file proves the pieces are wired
// together correctly, not the HTTP calls a second time.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const connectors = require('../../connectors');
const app = require('../../api/index');

const originalRegistry = { ...connectors.registry };

function installFakeConnector(action, execute) {
  connectors.registry[action] = { execute };
}

function restoreRegistry() {
  for (const key of Object.keys(connectors.registry)) delete connectors.registry[key];
  Object.assign(connectors.registry, originalRegistry);
}

test.afterEach(restoreRegistry);

function fakeInbox() {
  return [
    { id: 'promo1', from: 'Temu <deals@temu.com>', senderAddress: 'deals@temu.com', senderName: 'Temu', subject: '70% OFF everything - Limited time offer!', snippet: 'Shop now and save. Unsubscribe from these emails.', listUnsubscribe: '<https://temu.com/unsub>' },
    { id: 'promo2', from: 'Temu <deals@temu.com>', senderAddress: 'deals@temu.com', senderName: 'Temu', subject: 'Flash sale ends tonight - 80% off', snippet: 'Manage preferences or unsubscribe anytime.', listUnsubscribe: '<https://temu.com/unsub>' },
    { id: 'receipt1', from: 'Amazon <auto-confirm@amazon.co.uk>', senderAddress: 'auto-confirm@amazon.co.uk', senderName: 'Amazon', subject: 'Your order has shipped', snippet: 'Order #123 has shipped. Tracking number ABC.' },
    { id: 'personal1', from: 'Sam <sam@example.com>', senderAddress: 'sam@example.com', senderName: 'Sam', subject: 'Can you confirm tomorrow?', snippet: 'Can you confirm the numbers before 3pm today?' }
  ];
}

test('clean_inbox archives only the genuinely promotional messages, preserves the receipt and the reply-needed email, and unsubscribes once per sender', async () => {
  const archiveCalls = [];
  const unsubscribeCalls = [];
  let searchQuery = null;

  installFakeConnector('search_emails', async (userId, action, params) => {
    searchQuery = params.query;
    return { success: true, emails: fakeInbox() };
  });
  installFakeConnector('archive_emails', async (userId, action, params) => {
    archiveCalls.push(params.message_ids);
    return { success: true, modified: params.message_ids.length, failed: [], verified: { checked: params.message_ids.length, confirmed: params.message_ids.length } };
  });
  installFakeConnector('unsubscribe_email', async (userId, action, params) => {
    unsubscribeCalls.push(params.message_id);
    return { success: true, method: 'one-click' };
  });

  const result = await app.executeAction('user-1', 'clean_inbox', {});

  assert.equal(searchQuery, 'in:inbox');
  assert.equal(result.success, true);
  assert.equal(result.archived, 2, 'both Temu promos, and only them');
  assert.deepEqual(archiveCalls[0].sort(), ['promo1', 'promo2']);
  assert.equal(result.preserved, 2, 'the Amazon receipt and Sam\'s email must survive');
  // One unsubscribe attempt for Temu, not two — same sender, deduped.
  assert.equal(unsubscribeCalls.length, 1);
  assert.ok(['promo1', 'promo2'].includes(unsubscribeCalls[0]));
  assert.equal(result.unsubscribed.length, 1);
  assert.equal(result.unsubscribed[0].sender, 'Temu');
  assert.match(result.text, /archived 2 emails/i);
  assert.match(result.text, /unsubscribed from 1 mailing list \(Temu\)/);
  assert.match(result.text, /kept 2 because they looked important/);
});

test('clean_inbox scopes to a single sender without touching the rest of the inbox ("archive promotional emails from Temu")', async () => {
  let searchQuery = null;
  installFakeConnector('search_emails', async (userId, action, params) => {
    searchQuery = params.query;
    // A real Gmail from: search would only return Temu's own mail — simulate that.
    return { success: true, emails: fakeInbox().filter(e => e.senderAddress === 'deals@temu.com') };
  });
  installFakeConnector('archive_emails', async (userId, action, params) => ({
    success: true, modified: params.message_ids.length, failed: [], verified: { checked: 0, confirmed: 0 }
  }));
  installFakeConnector('unsubscribe_email', async () => ({ success: true, method: 'one-click' }));

  const result = await app.executeAction('user-1', 'clean_inbox', { sender: 'temu.com' });
  assert.equal(searchQuery, 'in:inbox from:temu.com');
  assert.equal(result.archived, 2);
});

test('clean_inbox with unsubscribe_senders:false archives but never attempts to unsubscribe', async () => {
  installFakeConnector('search_emails', async () => ({ success: true, emails: fakeInbox() }));
  installFakeConnector('archive_emails', async (userId, action, params) => ({
    success: true, modified: params.message_ids.length, failed: [], verified: { checked: 0, confirmed: 0 }
  }));
  let unsubscribeCalled = false;
  installFakeConnector('unsubscribe_email', async () => { unsubscribeCalled = true; return { success: true }; });

  const result = await app.executeAction('user-1', 'clean_inbox', { unsubscribe_senders: false });
  assert.equal(unsubscribeCalled, false);
  assert.equal(result.unsubscribed.length, 0);
});

test('clean_inbox reports a real partial failure truthfully instead of claiming full success', async () => {
  installFakeConnector('search_emails', async () => ({ success: true, emails: fakeInbox() }));
  installFakeConnector('archive_emails', async (userId, action, params) => ({
    success: false, modified: 0, failed: params.message_ids, verified: { checked: 0, confirmed: 0 }
  }));
  installFakeConnector('unsubscribe_email', async () => ({ success: false, error: 'endpoint returned status 500' }));

  const result = await app.executeAction('user-1', 'clean_inbox', {});
  assert.equal(result.archived, 0);
  assert.equal(result.archiveFailed, 2);
  assert.equal(result.unsubscribeFailed.length, 1);
  assert.match(result.text, /2 could not be archived/);
  assert.match(result.text, /1 unsubscribe attempt failed/);
});

test('clean_inbox surfaces needsBrowser unsubscribes distinctly rather than claiming they completed', async () => {
  installFakeConnector('search_emails', async () => ({ success: true, emails: fakeInbox() }));
  installFakeConnector('archive_emails', async (userId, action, params) => ({
    success: true, modified: params.message_ids.length, failed: [], verified: { checked: 0, confirmed: 0 }
  }));
  installFakeConnector('unsubscribe_email', async () => ({ success: false, needsBrowser: true, url: 'https://temu.com/manage-preferences' }));

  const result = await app.executeAction('user-1', 'clean_inbox', {});
  assert.equal(result.unsubscribed.length, 0);
  assert.equal(result.needsBrowserUnsubscribe.length, 1);
  assert.match(result.text, /1 more need a real page visit to finish unsubscribing/);
});

test('clean_inbox is honest when nothing in scope needs cleaning', async () => {
  installFakeConnector('search_emails', async () => ({ success: true, emails: [] }));
  const result = await app.executeAction('user-1', 'clean_inbox', { sender: 'nobody-sends-me-mail.example' });
  assert.equal(result.success, true);
  assert.equal(result.archived, 0);
  assert.match(result.text, /Nothing matched/);
});

test('clean_inbox surfaces a real search failure rather than pretending the inbox is clean', async () => {
  installFakeConnector('search_emails', async () => ({ success: false, error: 'Google not connected: token expired.' }));
  const result = await app.executeAction('user-1', 'clean_inbox', {});
  assert.equal(result.success, false);
  assert.match(result.error, /token expired/);
});

test('clean_inbox builds a before: date scope for "older than a month" style requests', async () => {
  let searchQuery = null;
  installFakeConnector('search_emails', async (userId, action, params) => { searchQuery = params.query; return { success: true, emails: [] }; });
  await app.executeAction('user-1', 'clean_inbox', { before: '2026-07-08' });
  assert.equal(searchQuery, 'in:inbox before:2026/07/08');
});
