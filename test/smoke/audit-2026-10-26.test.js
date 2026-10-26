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
