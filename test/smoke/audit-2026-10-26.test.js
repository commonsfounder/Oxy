const test = require('node:test');
const assert = require('node:assert');
const { hasExplicitUserAuthorization } = require('../../api/services/action-execution');

test('a filler word in the contact name does not count as naming the recipient', () => {
  const send = (contact) => ({ type: 'send_telegram', input: { contact, message: 'hi' } });
  assert.equal(hasExplicitUserAuthorization(send('My Boss'), 'text my sister that I am late'), false);
  assert.equal(hasExplicitUserAuthorization(send('Arina'), 'text Arina that I am late'), true);
});

test('chained questions and live-fact comparisons get the multi-step loop, plain ones do not', () => {
  const { shouldUseAgenticLoopForMessage: agentic } = require('../../api/index');
  assert.equal(agentic({ message: 'Who directed Paddington 2, what is the most recent film they directed, and is that film rated higher or lower than Paddington 2 on Rotten Tomatoes?' }), true);
  assert.equal(agentic({ message: 'Compare the tallest building in Birmingham with the tallest in Manchester: give both heights.' }), true);
  assert.equal(agentic({ message: 'Who directed Paddington 2?' }), false);
  assert.equal(agentic({ message: 'Compare cats and dogs as pets' }), false);
});

// Routes talk to Supabase, so these run the real app against a small in-memory stand-in.
test('password and email-verification routes', async (t) => {
  const runtime = require('../../runtime');
  process.env.OXY_SESSION_SECRET ||= 'test-session-secret';
  process.env.SUPABASE_URL ||= 'https://example.supabase.co';
  process.env.SUPABASE_KEY ||= 'test-key';
  process.env.OPENAI_API_KEY ||= 'test-openai-key';
  const tables = { users: [{ user_id: 'ann', token_version: 1, email: 'a@x.com' }], password_reset_tokens: [], chat_settings: [] };
  let failUserUpdate = false;
  const realFactory = runtime.createSupabaseServiceClient;
  runtime.createSupabaseServiceClient = () => ({
    from(table) {
      const state = { filters: [], op: 'select', patch: null };
      const rows = () => (tables[table] || []).filter((r) => state.filters.every(([c, v]) => r[c] === v));
      const chain = {
        select: () => chain, insert: (row) => { state.op = 'insert'; (tables[table] ||= []).push({ id: tables[table].length + 1, ...row }); return chain; },
        update: (patch) => { state.op = 'update'; state.patch = patch; return chain; },
        eq: (c, v) => { state.filters.push([c, v]); return chain; },
        single: () => chain, maybeSingle: () => chain,
        then: (resolve) => {
          if (state.op === 'update') {
            if (table === 'users' && failUserUpdate) return resolve({ error: { message: 'down' } });
            rows().forEach((r) => Object.assign(r, state.patch));
            return resolve({ error: null });
          }
          return resolve({ data: state.op === 'insert' ? null : (rows()[0] || null), error: null });
        }
      };
      return chain;
    }
  });
  t.after(() => { runtime.createSupabaseServiceClient = realFactory; });
  delete require.cache[require.resolve('../../api/index')];
  const app = require('../../api/index');
  const http = require('node:http');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { createSessionToken } = require('../../auth');
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${createSessionToken('ann', 1)}` };

  // A verification link works once, verifies the email, and cannot reset the password.
  const send = await fetch(`${base}/auth/verify-email`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(send.status, 200);
  const token = tables.password_reset_tokens[0].token;
  const asReset = await fetch(`${base}/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, newPassword: 'longenough1' }) });
  assert.equal(asReset.status, 400);
  const confirm = await fetch(`${base}/auth/verify-email/confirm?token=${token}`);
  assert.match(await confirm.text(), /verified/);
  assert.equal(tables.users[0].email_verified, true);
  assert.match(await (await fetch(`${base}/auth/verify-email/confirm?token=${token}`)).text(), /expired/);

  // A reset whose password write fails does not spend the token.
  tables.password_reset_tokens.push({ id: 99, user_id: 'ann', token: 'abc', expires_at: new Date(Date.now() + 60000).toISOString(), used: false });
  failUserUpdate = true;
  const failed = await fetch(`${base}/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'abc', newPassword: 'longenough1' }) });
  assert.equal(failed.status, 500);
  assert.equal(tables.password_reset_tokens.find((r) => r.id === 99).used, false);
  failUserUpdate = false;
  const ok = await fetch(`${base}/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'abc', newPassword: 'longenough1' }) });
  assert.equal(ok.status, 200);
  assert.equal(tables.password_reset_tokens.find((r) => r.id === 99).used, true);
});

test('background saved goals, voice and image turns all pass the stored guard mode to the action runner', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../../api/index'), 'utf8');
  const body = (start) => src.slice(src.indexOf(start), src.indexOf(start) + 2500);
  assert.match(body('async function runSavedGoal('), /guardMode: guardMode === true/);
  assert.match(body("app.post('/process-audio'") + src.slice(src.indexOf("app.post('/process-audio'"), src.indexOf("app.post('/pendant/transcribe'")), /guardMode: guardMode === true/);
  assert.match(src.slice(src.indexOf("app.post('/chat-with-image'"), src.indexOf("app.post('/memory'")), /guardMode: guardMode === true/);
});

test('the main chat loop is given the guard mode, and sending the same text twice is not collapsed into one receipt', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../../api/index'), 'utf8');
  const loopCall = src.slice(src.indexOf('const agentTurn = await runAgenticTurn('), src.indexOf('executeActionsFn: executeActions,', src.indexOf('const agentTurn = await runAgenticTurn(')));
  assert.match(loopCall, /guardMode: settings\.guardMode === true/);
  const { normalizeActionResultsForClient } = require('../../api/index');
  const sent = (to) => ({ action: 'send_telegram', input: { contact: to }, result: { success: true, text: 'Telegram sent' } });
  assert.equal(normalizeActionResultsForClient([sent('Ann'), sent('Bob')]).length, 2);
  assert.equal(normalizeActionResultsForClient([sent('Ann'), sent('Ann')]).length, 1);
});

test('only plain public domain names may be opened by the session check', () => {
  const { isPlainHostname } = require('../../api/lib/text');
  for (const ok of ['example.com', 'accounts.google.co.uk', 'john-lewis.com']) assert.equal(isPlainHostname(ok), true, ok);
  for (const bad of ['', 'localhost', 'x@internal.example', '169.254.169.254', 'a.com:8080', 'a.com/..', 'a.com#', '[::1]', 'bad host.com']) assert.equal(isPlainHostname(bad), false, bad);
});

test('list and object parameters are declared as lists and objects, not strings', () => {
  const { actionToFunctionDeclaration, ACTION_CONTRACTS } = require('../../api/action-contracts');
  const archive = actionToFunctionDeclaration('archive_emails', ACTION_CONTRACTS.archive_emails);
  assert.equal(archive.parameters.properties.message_ids.type, 'ARRAY');
  assert.equal(archive.parameters.properties.message_ids.items.type, 'STRING');
  const results = actionToFunctionDeclaration('show_results', ACTION_CONTRACTS.show_results);
  assert.equal(results.parameters.properties.results.items.type, 'OBJECT');
  const query = actionToFunctionDeclaration('search_emails', ACTION_CONTRACTS.search_emails);
  assert.equal(query.parameters.properties.query.type, 'STRING');
  // Lowercased for OpenAI by the provider seam, with items kept.
  const { geminiToolsToOpenAI } = require('../../api/services/brain-provider');
  const [tool] = geminiToolsToOpenAI([{ functionDeclarations: [archive] }]);
  assert.deepEqual(tool.function.parameters.properties.message_ids, { type: 'array', items: { type: 'string' }, description: tool.function.parameters.properties.message_ids.description });
});

test('Gmail ids sent as JSON text are still read as a list', () => {
  const { normalizeMessageIds } = (() => {
    const src = require('node:fs').readFileSync(require.resolve('../../connectors/google'), 'utf8');
    const fn = src.slice(src.indexOf('function normalizeMessageIds'), src.indexOf('// Gmail\'s built-in labels'));
    return { normalizeMessageIds: new Function(`${fn}; return normalizeMessageIds;`)() };
  })();
  assert.deepEqual(normalizeMessageIds('["a","b"]'), ['a', 'b']);
  assert.deepEqual(normalizeMessageIds(['a']), ['a']);
  assert.deepEqual(normalizeMessageIds('abc'), ['abc']);
});

test('Slack sends and wiping all memory wait for approval; forgetting one thing does not', async () => {
  const { getActionContract } = require('../../api/action-contracts');
  assert.equal(getActionContract('send_slack_message').executionMode, 'review');
  const { createActionExecution } = require('../../api/services/action-execution');
  const parked = [];
  const ran = [];
  const exec = createActionExecution({
    invokeAdapter: async ({ type }) => { ran.push(type); return { success: true, outcome: 'completed', text: 'ok' }; },
    setPendingAction: async (_u, action) => { parked.push(action.type); }
  });
  await exec('u', [{ type: 'forget_memory', input: { scope: 'all' } }], {});
  assert.deepEqual([parked, ran], [['forget_memory'], []]);
  await exec('u', [{ type: 'forget_memory', input: { scope: 'recent' } }], {});
  assert.deepEqual(ran, ['forget_memory']);
});

test('card charges are checked against the spend cap in the currency actually charged', async () => {
  const money = require('../../api/actions/money').handlers;
  const seen = [];
  const deps = { supabase: {}, stripeClient: null, guardConciergeSpend: async (_u, amount, currency) => { seen.push([amount, currency]); return { ok: false, error: 'blocked' }; } };
  const uk = { latitude: 52.4, longitude: -1.9 };
  await money.stripe_charge({ userId: 'u', params: { amount: 2550 }, context: { location: uk }, deps });
  await money.spend_from_concierge_account({ userId: 'u', params: { amount: 25.5 }, context: { location: uk }, deps });
  assert.deepEqual(seen, [[25.5, 'gbp'], [25.5, 'gbp']]);
});

test('turning off an approval setting waits for a yes, other settings do not', async () => {
  const { createActionExecution } = require('../../api/services/action-execution');
  const parked = [];
  const exec = createActionExecution({
    invokeAdapter: async () => ({ success: true, outcome: 'completed' }),
    setPendingAction: async (_u, action) => { parked.push(action.input.setting); }
  });
  await exec('u', [{ type: 'change_setting', input: { setting: 'ask_before_acting', value: 'off' } }], {});
  await exec('u', [{ type: 'change_setting', input: { setting: 'ask_before_acting', value: 'on' } }], {});
  await exec('u', [{ type: 'change_setting', input: { setting: 'appearance', value: 'night' } }], {});
  assert.deepEqual(parked, ['ask_before_acting']);
});

test('private addresses are refused in production and allowed for local tests', async () => {
  const { assertPublicHttpUrl, isPrivateAddress, hostLooksPrivate } = require('../../api/lib/safe-url');
  const prod = { NODE_ENV: 'production' };
  for (const bad of ['http://localhost:8080/', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://10.0.0.5/', 'http://[::1]/', 'http://[::ffff:192.168.1.1]/', 'https://db.internal/', 'http://myserver/', 'ftp://example.com/', 'file:///etc/passwd']) {
    await assert.rejects(assertPublicHttpUrl(bad, prod), undefined, bad);
  }
  await assertPublicHttpUrl('http://127.0.0.1:9000/', {});
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('172.32.0.1'), false);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(hostLooksPrivate('www.example.com'), false);
  await assertPublicHttpUrl('https://93.184.216.34/', prod);
});

test('the browser will not navigate to a private address when blocking is on', async (t) => {
  const { gotoBrowserPage } = require('../../api/services/browser-session');
  process.env.OXY_BLOCK_PRIVATE_URLS = 'on';
  t.after(() => { delete process.env.OXY_BLOCK_PRIVATE_URLS; });
  let visited = 0;
  const page = { goto: async () => { visited += 1; }, url: () => 'http://localhost:8080/', evaluate: async () => 0 };
  await assert.rejects(gotoBrowserPage(page, 'http://localhost:8080/'), /private network/);
  assert.equal(visited, 0);
  // A redirect that lands on a private address is caught after the fact and the page is blanked.
  const redirected = { goto: async () => { visited += 1; }, url: () => 'http://169.254.169.254/', evaluate: async () => 0 };
  await assert.rejects(gotoBrowserPage(redirected, 'https://example.com/'), /private network/);
});

test('project checks (which run code the model may have written) wait for approval', () => {
  const { getActionContract } = require('../../api/action-contracts');
  assert.equal(getActionContract('project_check').executionMode, 'review');
});

test('forgetting a named topic deletes only that topic, whatever scope word came with it', async (t) => {
  const runtime = require('../../runtime');
  process.env.OXY_SESSION_SECRET ||= 'test-session-secret';
  process.env.SUPABASE_URL ||= 'https://example.supabase.co';
  process.env.SUPABASE_KEY ||= 'test-key';
  process.env.OPENAI_API_KEY ||= 'test-openai-key';
  let rows = [
    { id: 1, user_id: 'u', content: 'Ada prefers silver', created_at: '2026-01-01' },
    { id: 2, user_id: 'u', content: 'Works at Acme', created_at: '2026-02-01' },
    { id: 3, user_id: 'u', content: 'Lives in Bath', created_at: '2026-03-01' }
  ];
  const realFactory = runtime.createSupabaseServiceClient;
  runtime.createSupabaseServiceClient = () => ({
    from() {
      const st = { op: 'select', filters: [], order: null, limit: null };
      const run = () => {
        let out = rows.filter((r) => st.filters.every((f) => f(r)));
        if (st.order) out = [...out].sort((a, b) => (a[st.order] < b[st.order] ? 1 : -1));
        if (st.limit) out = out.slice(0, st.limit);
        return out;
      };
      const chain = {
        select: () => chain, delete: () => { st.op = 'delete'; return chain; },
        eq: (c, v) => { st.filters.push((r) => r[c] === v); return chain; },
        ilike: (c, p) => { const needle = p.replace(/%/g, '').toLowerCase(); st.filters.push((r) => String(r[c]).toLowerCase().includes(needle)); return chain; },
        in: (c, vs) => { st.filters.push((r) => vs.includes(r[c])); return chain; },
        order: (c) => { st.order = c; return chain; }, limit: (n) => { st.limit = n; return chain; },
        then: (resolve) => {
          const hit = run();
          if (st.op === 'delete') { rows = rows.filter((r) => !hit.includes(r)); return resolve({ error: null }); }
          return resolve({ data: hit, error: null });
        }
      };
      return chain;
    },
    storage: {}
  });
  t.after(() => { runtime.createSupabaseServiceClient = realFactory; });
  delete require.cache[require.resolve('../../api/index')];
  const { forgetMemory } = require('../../api/index');
  await forgetMemory('u', { scope: 'all', query: 'silver' });
  assert.deepEqual(rows.map((r) => r.id), [2, 3]);
  await forgetMemory('u', { scope: 'recent', query: 'Acme' });
  assert.deepEqual(rows.map((r) => r.id), [3]);
  await forgetMemory('u', { scope: 'recent' });
  assert.deepEqual(rows, []);
});

test('only a no-topic "all" counts as wiping everything for approval', () => {
  const { getActionContract } = require('../../api/action-contracts');
  const { reviewWhen } = getActionContract('forget_memory');
  assert.equal(reviewWhen({ scope: 'all' }), true);
  assert.equal(reviewWhen({ scope: 'all', query: 'silver' }), false);
  assert.equal(reviewWhen({ scope: 'recent' }), false);
});

test('an email address with a line break cannot add hidden headers', () => {
  process.env.OXY_SESSION_SECRET ||= 'test-session-secret';
  process.env.SUPABASE_URL ||= 'https://example.supabase.co';
  process.env.SUPABASE_KEY ||= 'test-key';
  const { _private } = require('../../connectors/google');
  const decode = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(decode(_private.buildMime('a@b.com', 'Hi', 'Body')), /^To: a@b\.com\r\n/);
  assert.throws(() => _private.buildMime('a@b.com\r\nBcc: x@y.com', 'Hi', 'Body'), /line breaks/);
  assert.throws(() => _private.buildMime('a@b.com', 'Hi', 'Body', { inReplyTo: '<1@x>\nBcc: x@y.com' }), /line breaks/);
});

test('in production the shared Gmail token only serves the named owner', async (t) => {
  process.env.OXY_SESSION_SECRET ||= 'test-session-secret';
  process.env.SUPABASE_URL ||= 'https://example.supabase.co';
  process.env.SUPABASE_KEY ||= 'test-key';
  const saved = { env: process.env.NODE_ENV, token: process.env.GMAIL_REFRESH_TOKEN, owner: process.env.OXY_GMAIL_ENV_USER_ID, fetch: global.fetch };
  t.after(() => {
    for (const [key, value] of [['NODE_ENV', saved.env], ['GMAIL_REFRESH_TOKEN', saved.token], ['OXY_GMAIL_ENV_USER_ID', saved.owner]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.NODE_ENV = 'production';
  process.env.GMAIL_REFRESH_TOKEN = 'operator-refresh-token';
  delete process.env.OXY_GMAIL_ENV_USER_ID;
  const google = require('../../connectors/google');
  const result = await google.execute('some-other-user', 'get_emails', {});
  assert.equal(result.success, false);
  assert.match(result.error, /not configured/);
});
