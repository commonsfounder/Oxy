'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-session-secret';

const {
  USER_DATA_RESOURCES,
  auditLiveSchema,
  auditMigrationCoverage,
  createUserDataLifecycle,
  createUserDataRouteHandlers,
  UserDataLifecycleError,
  validateRegistry
} = require('../../api/services/user-data-lifecycle');
const app = require('../../api/index');
const { createSessionToken } = require('../../auth');

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.mode = 'select';
    this.rangeWindow = null;
  }

  select() { this.mode = 'select'; return this; }
  delete() { this.mode = 'delete'; return this; }
  eq(column, value) { this.filters.push(row => row[column] === value); return this; }
  in(column, values) { this.filters.push(row => values.includes(row[column])); return this; }
  range(from, to) { this.rangeWindow = [from, to]; return this; }

  then(resolve, reject) {
    try {
      if (this.db.failReads.has(this.table) && this.mode === 'select') {
        return resolve({ data: null, error: new Error(`read ${this.table} failed`) });
      }
      if (this.db.failDeletes.has(this.table) && this.mode === 'delete') {
        return resolve({ data: null, error: new Error(`delete ${this.table} failed`) });
      }
      const rows = this.db.rows[this.table] || [];
      const matched = rows.filter(row => this.filters.every(filter => filter(row)));
      const selected = this.rangeWindow ? matched.slice(this.rangeWindow[0], this.rangeWindow[1] + 1) : matched;
      if (this.mode === 'select') this.db.calls.push({ type: 'db-read', table: this.table });
      if (this.mode === 'delete') {
        this.db.calls.push({ type: 'db-delete', table: this.table });
        this.db.rows[this.table] = rows.filter(row => !matched.includes(row));
      }
      return resolve({ data: this.mode === 'select' ? selected : null, error: null });
    } catch (error) {
      return reject(error);
    }
  }
}

function fakeDb(rows = {}) {
  const db = {
    rows: structuredClone(rows),
    calls: [],
    failReads: new Set(),
    failDeletes: new Set(),
    from(table) { return new FakeQuery(this, table); }
  };
  return db;
}

function completeMigrationSql() {
  const dir = path.join(__dirname, '../../supabase/migrations');
  return fs.readdirSync(dir).filter(name => name.endsWith('.sql')).map(name => fs.readFileSync(path.join(dir, name), 'utf8'));
}

test('the migration coverage auditor covers every current table and explicit globals', () => {
  const result = auditMigrationCoverage({ migrationSql: completeMigrationSql() });
  assert.equal(result.missing.length, 0);
  assert.equal(result.stale.length, 0);
  assert.equal(result.duplicateRegistry, 0);
  assert.throws(() => validateRegistry([...USER_DATA_RESOURCES, USER_DATA_RESOURCES[0]]), /Duplicate/);
  assert.throws(() => validateRegistry([{ name: 'child', ownership: { kind: 'parent', parentTable: 'gone', parentColumn: 'id', foreignColumn: 'parent_id' } }]), /parent/i);
  assert.throws(() => auditMigrationCoverage({
    resources: [{ name: 'accounts', ownership: { kind: 'direct', column: 'user_id' } }],
    migrationSql: ['create table accounts (id uuid);']
  }), /direct ownership column/);
  assert.throws(() => auditMigrationCoverage({
    resources: [
      { name: 'users', ownership: { kind: 'direct', column: 'user_id' } },
      { name: 'children', ownership: { kind: 'parent', parentTable: 'users', parentColumn: 'id', foreignColumn: 'owner_id' } }
    ],
    migrationSql: ['create table users (id uuid, user_id text); create table children (wrong_id uuid references users(id));']
  }), /FK/);
  assert.throws(() => auditMigrationCoverage({
    resources: [{ name: 'global', ownership: { kind: 'global', reason: 'test' } }],
    migrationSql: ['create table global (id uuid, user_id text);']
  }), /global.*direct/i);
  assert.throws(() => validateRegistry([
    { name: 'a', ownership: { kind: 'parent', parentTable: 'b', parentColumn: 'id', foreignColumn: 'b_id' } },
    { name: 'b', ownership: { kind: 'parent', parentTable: 'a', parentColumn: 'id', foreignColumn: 'a_id' } }
  ]), /cycle/i);
});

test('export returns complete user resources, decrypts content, signs documents, and redacts secrets', async () => {
  const db = fakeDb({
    users: [{ user_id: 'u1', email: 'u@example.com', password_hash: 'hash', token_version: 3 }],
    conversations: [{ id: 'c1', user_id: 'u1', role: 'user', content: 'hello' }],
    action_log: [{ id: 'log-1', user_id: 'u1', action: JSON.stringify({ type: 'send_email', input: { to: 'a@example.com', body: 'hello', access_token: 'secret', nested: { password: 'secret', safe: 'keep' }, envelope: { encrypted: true, alg: 'aes-256-gcm', iv: 'iv', ciphertext: 'secret', tag: 'tag' } } }) }],
    preferences: [
      { id: 'pref-1', user_id: 'u1', key: 'payment_action_required', value: JSON.stringify({ clientSecret: 'secret', description: 'safe' }) },
      { id: 'pref-2', user_id: 'u1', key: 'style', value: 'plain user-authored preference' }
    ],
    connectors: [{ id: 'co1', user_id: 'u1', connector_id: 'google', tokens: { access_token: 'secret' }, enabled: true }],
    agent_runtime_approvals: [{ id: 'approval-1', user_id: 'u1', action_payload: { envelope: { encrypted: true, alg: 'aes-256-gcm', iv: 'iv', ciphertext: 'secret', tag: 'tag' } } }],
    password_reset_tokens: [{ id: 'reset-1', user_id: 'u1', token: 'secret-reset-token' }],
    documents: [{ id: 'd1', user_id: 'u1', filename: 'cv.pdf', storage_path: 'u1/private', extracted_encrypted: { text: 'my CV' } }],
    document_representations: [{ id: 'r1', document_id: 'd1', content_encrypted: { text: 'safe reading' }, producer: 'test' }],
    external_conversations: [{ id: 'ec1', user_id: 'u1' }],
    external_conversation_events: [{ id: 'ee1', conversation_id: 'ec1', body_encrypted: { subject: 'hi', body: 'there' }, raw_provider_payload: { access_token: 'no' } }],
    participants: [{ id: 'p1', user_id: 'u1', display_name: 'A' }],
    participant_addresses: [{ id: 'pa1', participant_id: 'p1', address_value: 'a@example.com' }]
  });
  const signed = [];
  const lifecycle = createUserDataLifecycle({
    db,
    signUrl: async pathName => { signed.push(pathName); return { signedUrl: `https://signed/${pathName}` }; }
  });
  const output = await lifecycle.exportUserData('u1');

  assert.equal(output.user.password_hash, undefined);
  assert.equal(output.connectors[0].tokens, undefined);
  assert.equal(output.connectors[0].hasTokens, true);
  assert.equal(output.resources.documents[0].storage_path, undefined);
  assert.equal(output.resources.documents[0].downloadUrl, 'https://signed/u1/private');
  assert.deepEqual(output.resources.documents[0].content, { text: 'my CV' });
  assert.deepEqual(output.resources.document_representations[0].content, { text: 'safe reading' });
  assert.deepEqual(output.resources.external_conversation_events[0].content, { subject: 'hi', body: 'there' });
  assert.equal(output.resources.external_conversation_events[0].raw_provider_payload, undefined);
  assert.deepEqual(output.resources.agent_runtime_approvals[0].action_payload, {});
  assert.deepEqual(output.resources.action_log[0].action, { type: 'send_email', input: { to: 'a@example.com', body: 'hello', nested: { safe: 'keep' } } });
  assert.deepEqual(output.resources.preferences.find(row => row.id === 'pref-1').value, { description: 'safe' });
  assert.equal(output.resources.preferences.find(row => row.id === 'pref-2').value, 'plain user-authored preference');
  assert.equal(output.resources.password_reset_tokens, undefined);
  assert.ok(output.exportManifest.excluded.some(item => item.resource === 'password_reset_tokens' && item.count === 1));
  assert.deepEqual(signed, ['u1/private']);
  assert.equal(output.conversations.length, 1, 'old top-level keys remain available');
  assert.ok(output.exportManifest.included.some(item => item.resource === 'documents' && item.count === 1));
  assert.ok(output.exportManifest.excluded.some(item => item.resource === 'rate_limits'));
  assert.ok(output.exportManifest.redactions.some(item => item.resource === 'connectors' && item.column === 'tokens'));
  assert.ok(output.exportManifest.redactions.some(item => item.resource === 'users' && item.column === 'password_hash'));
});

test('export fails when an owned document cannot be signed', async () => {
  const db = fakeDb({ users: [{ user_id: 'u1' }], documents: [{ id: 'd1', user_id: 'u1', storage_path: 'private' }] });
  const lifecycle = createUserDataLifecycle({ db, signUrl: async () => ({ error: new Error('signing down') }) });
  await assert.rejects(() => lifecycle.exportUserData('u1'), error => error instanceof UserDataLifecycleError && error.code === 'EXPORT_SIGN_FAILED');
});

test('export paginates large owned resources instead of trusting the REST row cap', async () => {
  const db = fakeDb({
    users: [{ user_id: 'u1' }],
    conversations: Array.from({ length: 1001 }, (_, index) => ({ id: `c-${index}`, user_id: 'u1', content: String(index) }))
  });
  const lifecycle = createUserDataLifecycle({ db });
  const output = await lifecycle.exportUserData('u1');
  assert.equal(output.resources.conversations.length, 1001);
});

test('deletion removes blobs first, children before parents, users last, and clears cache only after success', async () => {
  const db = fakeDb({
    users: [{ user_id: 'u1' }],
    documents: [{ id: 'd1', user_id: 'u1', storage_path: 'private' }],
    document_representations: [{ id: 'r1', document_id: 'd1' }],
    participants: [{ id: 'p1', user_id: 'u1' }],
    participant_addresses: [{ id: 'pa1', participant_id: 'p1' }]
  });
  db.storage = { from: () => ({ remove: async paths => { db.calls.push({ type: 'storage-remove', paths }); return { error: null }; } }) };
  let cacheCleared = 0;
  const lifecycle = createUserDataLifecycle({ db, storage: db.storage, clearCaches: () => { cacheCleared += 1; } });
  const result = await lifecycle.deleteUserData('u1');
  assert.equal(result.success, true);
  assert.equal(cacheCleared, 1);
  assert.equal(db.rows.users.length, 0);
  const order = db.calls.filter(call => call.type === 'storage-remove' || call.type === 'db-delete').map(call => call.type === 'storage-remove' ? 'storage' : call.table);
  assert.equal(order[0], 'storage');
  assert.ok(order.indexOf('document_representations') < order.indexOf('documents'));
  assert.ok(order.indexOf('participant_addresses') < order.indexOf('participants'));
  assert.equal(order.at(-1), 'users');
});

test('a partial deletion is incomplete and retry finishes without cache clearing on failure', async () => {
  const db = fakeDb({ users: [{ user_id: 'u1' }], conversations: [{ id: 'c', user_id: 'u1' }] });
  db.failDeletes.add('conversations');
  let cacheCleared = 0;
  const lifecycle = createUserDataLifecycle({ db, clearCaches: () => { cacheCleared += 1; } });
  await assert.rejects(() => lifecycle.deleteUserData('u1'), error => error instanceof UserDataLifecycleError && error.details.incomplete === true);
  assert.equal(cacheCleared, 0);
  db.failDeletes.clear();
  const result = await lifecycle.deleteUserData('u1');
  assert.equal(result.success, true);
  assert.equal(cacheCleared, 1);
  assert.deepEqual(db.rows.users, []);
});

test('storage deletion failure is a bounded incomplete lifecycle error before any DB delete', async () => {
  const db = fakeDb({ users: [{ user_id: 'u1' }], documents: [{ id: 'd1', user_id: 'u1', storage_path: 'private' }] });
  db.storage = { from: () => ({ remove: async () => ({ error: new Error('storage unavailable') }) }) };
  const lifecycle = createUserDataLifecycle({ db, storage: db.storage });
  await assert.rejects(() => lifecycle.deleteUserData('u1'), error => error.code === 'DELETE_STORAGE_FAILED' && error.details.incomplete === true);
  assert.equal(db.calls.some(call => call.type === 'db-delete'), false);
});

test('transitive children belonging to another user are not exported or deleted', async () => {
  const db = fakeDb({
    users: [{ user_id: 'u1' }],
    documents: [{ id: 'd1', user_id: 'u1' }, { id: 'd2', user_id: 'u2' }],
    document_representations: [{ id: 'r1', document_id: 'd1' }, { id: 'r2', document_id: 'd2' }]
  });
  const lifecycle = createUserDataLifecycle({ db });
  const output = await lifecycle.exportUserData('u1');
  assert.deepEqual(output.resources.document_representations.map(row => row.id), ['r1']);
  await lifecycle.deleteUserData('u1');
  assert.deepEqual(db.rows.document_representations.map(row => row.id), ['r2']);
  assert.deepEqual(db.rows.documents.map(row => row.id), ['d2']);
});

test('export and deletion routes keep matching-user authentication before lifecycle work', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const headers = { Authorization: `Bearer ${createSessionToken('u1')}` };
    for (const [method, route] of [['GET', '/user/u2/export'], ['DELETE', '/user/u2']]) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers });
      assert.equal(response.status, 403);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function fakeResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('route handlers preserve successful payloads and bounded export/delete failures through an injected lifecycle', async () => {
  const calls = [];
  const lifecycle = {
    exportUserData: async userId => { calls.push(['export', userId]); return { exportedAt: 'now', userId }; },
    deleteUserData: async userId => { calls.push(['delete', userId]); return { success: true, deleted: true }; }
  };
  const handlers = createUserDataRouteHandlers({ lifecycle, requireMatchingUser: () => true, logger: { error() {} } });
  const exportResponse = fakeResponse();
  await handlers.export({ params: { userId: 'u1' } }, exportResponse);
  assert.equal(exportResponse.statusCode, 200);
  assert.equal(exportResponse.headers['Content-Disposition'], 'attachment; filename="milgrain-data-export.json"');
  assert.deepEqual(exportResponse.body, { exportedAt: 'now', userId: 'u1' });
  const deleteResponse = fakeResponse();
  await handlers.delete({ params: { userId: 'u1' } }, deleteResponse);
  assert.deepEqual(deleteResponse.body, { success: true, deleted: true });
  lifecycle.exportUserData = async () => { throw new Error('db down'); };
  lifecycle.deleteUserData = async () => { throw new Error('partial'); };
  const exportFailure = fakeResponse();
  const deleteFailure = fakeResponse();
  await handlers.export({ params: { userId: 'u1' } }, exportFailure);
  await handlers.delete({ params: { userId: 'u1' } }, deleteFailure);
  assert.equal(exportFailure.statusCode, 500);
  assert.deepEqual(exportFailure.body, { error: 'Could not export your data right now.' });
  assert.equal(deleteFailure.statusCode, 500);
  assert.deepEqual(deleteFailure.body, { error: 'Could not delete your account right now.', success: false, deleted: false, incomplete: true });
  assert.deepEqual(calls, [['export', 'u1'], ['delete', 'u1']]);
});

test('the registry executes every non-global resource once, deletes excluded secrets, and keeps storage/users boundaries', async () => {
  const rows = {};
  for (const resource of USER_DATA_RESOURCES) {
    if (resource.ownership.kind === 'global') continue;
    if (resource.ownership.kind === 'direct') {
      rows[resource.name] = [{ id: `${resource.name}-1`, user_id: 'u1', ...(resource.name === 'documents' ? { storage_path: 'doc/path' } : {}) }];
    }
  }
  for (const resource of USER_DATA_RESOURCES.filter(item => item.ownership.kind === 'parent')) {
    const parentRows = rows[resource.ownership.parentTable] || [{ id: `${resource.ownership.parentTable}-1`, user_id: 'u1' }];
    rows[resource.ownership.parentTable] = parentRows;
    rows[resource.name] = [{ id: `${resource.name}-1`, [resource.ownership.foreignColumn]: parentRows[0][resource.ownership.parentColumn] }];
  }
  const db = fakeDb(rows);
  db.storage = { from: () => ({ remove: async paths => { db.calls.push({ type: 'storage-remove', paths }); return { error: null }; } }) };
  const lifecycle = createUserDataLifecycle({ db, storage: db.storage, signUrl: async storagePath => ({ signedUrl: `signed:${storagePath}` }) });
  const nonGlobal = USER_DATA_RESOURCES.filter(resource => resource.ownership.kind !== 'global');
  await lifecycle.exportUserData('u1');
  const readCounts = {};
  for (const call of db.calls.filter(item => item.type === 'db-read')) readCounts[call.table] = (readCounts[call.table] || 0) + 1;
  for (const resource of nonGlobal) assert.equal(readCounts[resource.name], 1, `${resource.name} should be read once`);
  assert.equal((await lifecycle.exportUserData('u1')).resources.password_reset_tokens, undefined);
  db.calls = [];
  await lifecycle.deleteUserData('u1');
  const deleteCalls = db.calls.filter(call => call.type === 'db-delete').map(call => call.table);
  for (const resource of nonGlobal) assert.equal(deleteCalls.filter(table => table === resource.name).length, 1, `${resource.name} should be deletion-attempted once`);
  const mutationCalls = db.calls.filter(call => call.type === 'storage-remove' || call.type === 'db-delete');
  assert.equal(mutationCalls[0].type, 'storage-remove');
  assert.equal(deleteCalls.at(-1), 'users');
});

test('deletion batches more than 1000 document blobs and parent ids', async () => {
  const documents = Array.from({ length: 1001 }, (_, index) => ({ id: `doc-${index}`, user_id: 'u1', storage_path: `doc/${index}` }));
  const representations = documents.map(document => ({ id: `rep-${document.id}`, document_id: document.id }));
  const db = fakeDb({ users: [{ user_id: 'u1' }], documents, document_representations: representations });
  const storageBatches = [];
  db.storage = { from: () => ({ remove: async paths => { storageBatches.push(paths); return { error: null }; } }) };
  await createUserDataLifecycle({ db, storage: db.storage }).deleteUserData('u1');
  assert.deepEqual(storageBatches.map(batch => batch.length), [500, 500, 1]);
  assert.equal(db.rows.documents.length, 0);
  assert.equal(db.rows.document_representations.length, 0);
});

test('injected registries use their own parent map rather than module-global resources', async () => {
  const resources = [
    { name: 'accounts', ownership: { kind: 'direct', column: 'user_id' }, deletionOrder: 1 },
    { name: 'account_notes', ownership: { kind: 'parent', parentTable: 'accounts', parentColumn: 'id', foreignColumn: 'account_id' }, deletionOrder: 2 }
  ];
  const db = fakeDb({ accounts: [{ id: 'a1', user_id: 'u1' }], account_notes: [{ id: 'n1', account_id: 'a1', body: 'kept' }] });
  const lifecycle = createUserDataLifecycle({ db, resources });
  const exported = await lifecycle.exportUserData('u1');
  assert.equal(exported.resources.account_notes[0].body, 'kept');
  await lifecycle.deleteUserData('u1');
  assert.equal(db.rows.account_notes.length, 0);
});

test('the live schema auditor catches tables the database is actually missing', () => {
  const registryNames = USER_DATA_RESOURCES.map(resource => resource.name);

  // A database that really does contain every declared table is the only clean case.
  const healthy = auditLiveSchema({ liveTables: registryNames });
  assert.equal(healthy.absent.length, 0);
  assert.equal(healthy.unregistered.length, 0);

  // This is the exact production failure of 2026-08-24: the manifest and the migration
  // files agreed with each other, so the file-based auditor stayed green, while the live
  // database was missing the tables and every account deletion returned a 500.
  assert.throws(() => auditLiveSchema({
    liveTables: registryNames.filter(name => name !== 'travel_sessions' && name !== 'paired_displays')
  }), /travel_sessions/);
  assert.throws(() => auditLiveSchema({
    liveTables: registryNames.filter(name => name !== 'paired_displays')
  }), /paired_displays/);

  // The other direction: a table nobody declared is how retired features leave user data
  // behind, which is what ubereats_sessions did for two months after its code was reverted.
  assert.throws(() => auditLiveSchema({
    liveTables: [...registryNames, 'ubereats_sessions']
  }), /ubereats_sessions/);

  // An unknown table can be explicitly accepted, so a deliberate non-app table does not
  // become a reason to start ignoring the check.
  const ignored = auditLiveSchema({
    liveTables: [...registryNames, 'some_external_table'],
    ignore: ['some_external_table']
  });
  assert.equal(ignored.unregistered.length, 0);

  // A missing table is reported even when an unknown one is also present.
  assert.throws(() => auditLiveSchema({
    liveTables: [...registryNames.filter(name => name !== 'purchases'), 'mystery_table']
  }), /purchases/);
});
