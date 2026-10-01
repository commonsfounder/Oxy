const assert = require('node:assert/strict');
const test = require('node:test');

const pairedDisplays = require('../../api/services/paired-displays');
const { validateActionWithContract, hasExplicitDisplayIntent } = require('../../api/action-contracts');

function fakeSupabase({ redeemError = null, redeemDelay = 0 } = {}) {
  const tables = {
    display_pairing_challenges: [],
    paired_displays: [],
    display_render_events: []
  };
  let sequence = 0;

  function matches(row, filters) {
    return Object.entries(filters).every(([key, value]) => value === null
      ? row[key] == null
      : row[key] === value);
  }

  function from(table) {
    const state = { filters: {}, patch: null, insert: null, order: null, limit: null };
    const chain = {
      select() { return chain; },
      eq(key, value) { state.filters[key] = value; return chain; },
      is(key, value) { state.filters[key] = value; return chain; },
      gt(key, value) { state.gt = { key, value }; return chain; },
      order(key, options) { state.order = { key, ascending: options?.ascending !== false }; return chain; },
      limit(value) { state.limit = value; return chain; },
      insert(row) {
        const nowValue = '2026-08-23T00:00:' + String(sequence++).padStart(2, '0') + '.000Z';
        const inserted = { id: table + '-' + sequence, created_at: nowValue, paired_at: nowValue, ...row };
        tables[table].push(inserted);
        state.insert = inserted;
        return chain;
      },
      update(patch) {
        state.patch = patch;
        return chain;
      },
      single() {
        if (state.insert) return Promise.resolve({ data: state.insert, error: null });
        const row = tables[table].find(item => matches(item, state.filters));
        return Promise.resolve(row
          ? { data: { ...row, ...state.patch }, error: null }
          : { data: null, error: new Error('not found') });
      },
      maybeSingle() {
        const row = tables[table].find(item => {
          if (!matches(item, state.filters)) return false;
          if (state.gt && !(new Date(item[state.gt.key]) > new Date(state.gt.value))) return false;
          return true;
        });
        if (row && state.patch) Object.assign(row, state.patch);
        return Promise.resolve({ data: row || null, error: null });
      },
      then(resolve, reject) {
        if (state.patch) {
          tables[table].filter(item => matches(item, state.filters)).forEach(item => Object.assign(item, state.patch));
        }
        let rows = tables[table].filter(item => {
          if (!matches(item, state.filters)) return false;
          if (state.gt && !(new Date(item[state.gt.key]) > new Date(state.gt.value))) return false;
          return true;
        });
        if (state.order) {
          rows = [...rows].sort((a, b) => {
            const left = new Date(a[state.order.key]).getTime();
            const right = new Date(b[state.order.key]).getTime();
            return state.order.ascending ? left - right : right - left;
          });
        }
        if (state.limit != null) rows = rows.slice(0, state.limit);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      }
    };
    return chain;
  }

  async function redeemDisplayPairing(args) {
    if (redeemDelay) await new Promise(resolve => setTimeout(resolve, redeemDelay));
    if (redeemError) return { data: null, error: redeemError };
    const challenge = tables.display_pairing_challenges.find(row => row.id === args.p_challenge_id
      && row.code_hash === args.p_code_hash
      && row.consumed_at == null
      && new Date(row.expires_at).getTime() > new Date(args.p_paired_at).getTime());
    if (!challenge) return { data: null, error: new Error('That pairing request is invalid or expired.') };
    const nowValue = '2026-08-23T00:01:' + String(sequence++).padStart(2, '0') + '.000Z';
    const display = {
      id: 'paired-' + sequence,
      display_name: args.p_display_name,
      display_type: 'browser_display',
      capabilities: { text: true },
      paired_at: args.p_paired_at,
      last_seen_at: null,
      token_hash: args.p_token_hash,
      user_id: challenge.user_id,
      created_at: nowValue
    };
    tables.paired_displays.push(display);
    challenge.consumed_at = args.p_paired_at;
    challenge.display_id = display.id;
    return { data: { display }, error: null };
  }

  return { tables, from, rpc(name, args) {
    assert.equal(name, 'redeem_display_pairing');
    return redeemDisplayPairing(args);
  } };
}

const now = new Date('2026-08-23T12:00:00.000Z');
const deterministicRandom = length => Buffer.alloc(length, length === 10 ? 0 : 1);

test('pairing challenge is one-time, expires, and never stores the raw code', async () => {
  const db = fakeSupabase();
  const challenge = await pairedDisplays.createPairingChallenge(db, 'user-1', {
    baseUrl: 'https://oxy.example',
    now,
    randomBytes: deterministicRandom
  });
  assert.equal(challenge.code, 'AAAAAAAA');
  assert.match(challenge.displayUrl, /^https:\/\/oxy\.example\/display\?challenge=/);
  assert.notEqual(db.tables.display_pairing_challenges[0].code, challenge.code);

  await assert.rejects(
    () => pairedDisplays.redeemPairingChallenge(db, {
      challengeId: challenge.id, code: 'BBBBBBBB', now, randomBytes: deterministicRandom
    }),
    /not correct/
  );
  const redeemed = await pairedDisplays.redeemPairingChallenge(db, {
    challengeId: challenge.id, code: challenge.code, displayName: 'Kitchen screen', now,
    randomBytes: deterministicRandom
  });
  assert.equal(redeemed.display.name, 'Kitchen screen');
  assert.ok(redeemed.token);
  assert.equal(Object.hasOwn(redeemed.display, 'token'), false);
  await assert.rejects(
    () => pairedDisplays.redeemPairingChallenge(db, {
      challengeId: challenge.id, code: challenge.code, now, randomBytes: deterministicRandom
    }),
    /no longer valid|already used/
  );
  assert.equal(db.tables.paired_displays.length, 1);

  const expired = await pairedDisplays.createPairingChallenge(db, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  });
  await assert.rejects(
    () => pairedDisplays.redeemPairingChallenge(db, {
      challengeId: expired.id,
      code: expired.code,
      now: new Date(now.getTime() + pairedDisplays.PAIRING_TTL_MS + 1),
      randomBytes: deterministicRandom
    }),
    /expired/
  );
});

test('redemption is one atomic boundary for failures and concurrent redeemers', async () => {
  const failedDb = fakeSupabase({ redeemError: new Error('display insert failed') });
  const failedChallenge = await pairedDisplays.createPairingChallenge(failedDb, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  });
  await assert.rejects(
    () => pairedDisplays.redeemPairingChallenge(failedDb, {
      challengeId: failedChallenge.id, code: failedChallenge.code, now, randomBytes: deterministicRandom
    }),
    /display insert failed/
  );
  assert.equal(failedDb.tables.display_pairing_challenges[0].consumed_at, undefined);
  assert.equal(failedDb.tables.paired_displays.length, 0);

  const claimLostDb = fakeSupabase({ redeemError: { code: 'P0001', message: 'claim lost' } });
  const claimLostChallenge = await pairedDisplays.createPairingChallenge(claimLostDb, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  });
  await assert.rejects(
    () => pairedDisplays.redeemPairingChallenge(claimLostDb, {
      challengeId: claimLostChallenge.id, code: claimLostChallenge.code, now, randomBytes: deterministicRandom
    }),
    error => error.code === 'invalid_pairing'
  );

  const concurrentDb = fakeSupabase({ redeemDelay: 1 });
  const concurrentChallenge = await pairedDisplays.createPairingChallenge(concurrentDb, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  });
  const attempts = await Promise.allSettled([
    pairedDisplays.redeemPairingChallenge(concurrentDb, {
      challengeId: concurrentChallenge.id, code: concurrentChallenge.code, now, randomBytes: deterministicRandom
    }),
    pairedDisplays.redeemPairingChallenge(concurrentDb, {
      challengeId: concurrentChallenge.id, code: concurrentChallenge.code, now, randomBytes: deterministicRandom
    })
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  assert.equal(concurrentDb.tables.paired_displays.length, 1);
});

test('render is bounded, token-scoped, and acknowledged exactly once', async () => {
  const db = fakeSupabase();
  const challenge = await pairedDisplays.createPairingChallenge(db, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  });
  const { display, token } = await pairedDisplays.redeemPairingChallenge(db, {
    challengeId: challenge.id, code: challenge.code, now, randomBytes: deterministicRandom
  });
  const event = await pairedDisplays.queueRender(db, 'user-1', {
    displayId: display.id, title: 'Dinner', body: 'x'.repeat(3000), now
  });
  assert.equal(event.title, 'Dinner');
  assert.equal(event.body.length, pairedDisplays.MAX_BODY);

  const polled = await pairedDisplays.pollNextRender(db, display.id, token, now);
  assert.equal(polled.event.id, event.id);
  assert.equal(db.tables.paired_displays[0].last_seen_at, now.toISOString());
  assert.deepEqual(Object.keys(polled.event).sort(), ['body', 'createdAt', 'expiresAt', 'id', 'kind', 'title']);
  assert.equal(Object.hasOwn(polled.display, 'tokenHash'), false);
  assert.equal(Object.hasOwn(polled.display, 'token_hash'), false);
  assert.equal((await pairedDisplays.acknowledgeRender(db, display.id, token, event.id, now)).acknowledged, true);
  assert.equal((await pairedDisplays.acknowledgeRender(db, display.id, token, event.id, now)).alreadyAcknowledged, true);
  assert.equal((await pairedDisplays.pollNextRender(db, display.id, token, now)).event, null);
  assert.equal(await pairedDisplays.pollNextRender(db, display.id, 'wrong-token', now), null);
});

test('display content rejects credentials, raw payloads, and non-text values before insert', async () => {
  const db = fakeSupabase();
  const challenge = await pairedDisplays.createPairingChallenge(db, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  });
  const { display } = await pairedDisplays.redeemPairingChallenge(db, {
    challengeId: challenge.id, code: challenge.code, now, randomBytes: deterministicRandom
  });
  const unsafe = [
    ['Auth', 'Authorization: Bearer sk-live-secret'],
    ['Password', 'password=hunter2'],
    ['Token', 'access_token: abc123'],
    ['Cookie', 'Cookie: session=secret'],
    ['Key', '-----BEGIN PRIVATE KEY-----'],
    ['JSON', '{"provider":"gmail","payload":{"body":"private"}}'],
    ['Embedded JSON', 'Results: {"provider":"gmail","payload":{"body":"private"}}']
  ];
  for (const [title, body] of unsafe) {
    await assert.rejects(
      () => pairedDisplays.queueRender(db, 'user-1', { displayId: display.id, title, body, now }),
      /credentials or raw payloads/,
      `unsafe display content accepted: ${title}`
    );
  }
  await assert.rejects(
    () => pairedDisplays.queueRender(db, 'user-1', {
      displayId: display.id, title: 'Update', body: 'Safe text', kind: 'access_token: abc123', now
    }),
    /unsupported kind/
  );
  await assert.rejects(
    () => pairedDisplays.queueRender(db, 'user-1', { displayId: display.id, title: { raw: true }, body: 'text', now }),
    /plain text/
  );
  assert.equal(db.tables.display_render_events.length, 0);
});

test('render action requires explicit display intent in the originating user turn', () => {
  assert.equal(hasExplicitDisplayIntent('Put the dinner reservation on my display'), true);
  assert.equal(hasExplicitDisplayIntent('Show this on the Kitchen display'), true);
  assert.equal(hasExplicitDisplayIntent('Send this to the living room TV'), true);
  assert.equal(hasExplicitDisplayIntent('What is on my display?'), false);
  assert.equal(hasExplicitDisplayIntent("Don't show this on my display"), false);
  assert.equal(hasExplicitDisplayIntent('Did you put that on my screen?'), false);
  assert.equal(hasExplicitDisplayIntent('Why did you show that on my display?'), false);
  assert.equal(hasExplicitDisplayIntent('Have you put that on my display?'), false);
  assert.equal(hasExplicitDisplayIntent('Please show this on my display'), true);
  assert.equal(hasExplicitDisplayIntent('Could you put this on my screen?'), true);
  assert.equal(hasExplicitDisplayIntent('Remind me about the dinner reservation'), false);
  const action = { type: 'render_to_display', input: { display_id: 'd1', title: 'Dinner', body: '7:30pm' } };
  assert.match(validateActionWithContract(action, 'Remind me about the dinner reservation').error, /direct request/);
  assert.equal(validateActionWithContract(action, 'Put the dinner reservation on my display'), null);
});

test('revoked displays stop receiving content', async () => {
  const db = fakeSupabase();
  const challenge = await pairedDisplays.createPairingChallenge(db, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  });
  const { display, token } = await pairedDisplays.redeemPairingChallenge(db, {
    challengeId: challenge.id, code: challenge.code, now, randomBytes: deterministicRandom
  });
  assert.equal(await pairedDisplays.revokeDisplay(db, 'user-1', display.id, now), true);
  assert.equal(await pairedDisplays.pollNextRender(db, display.id, token, now), null);
});

test('a generated scene is wrapped in a locked-down page, and plain text stays plain', async () => {
  const displayScene = require('../../api/services/display-scene');
  const db = fakeSupabase();
  const challenge = await pairedDisplays.createPairingChallenge(db, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  });
  const { display, token } = await pairedDisplays.redeemPairingChallenge(db, {
    challengeId: challenge.id, code: challenge.code, now, randomBytes: deterministicRandom
  });
  const html = '<div class="scene"><h1 class="title">Bleed a radiator</h1><ol class="steps"><li class="on">Turn the heating off</li></ol><script>document.querySelector(".steps").style.opacity=1</script></div>';
  const event = await pairedDisplays.queueRender(db, 'user-1', {
    displayId: display.id, title: 'Bleed a radiator', body: 'Four steps. First turn the heating off.', sceneHtml: html, now
  });
  assert.equal(event.kind, 'scene');
  assert.equal(event.scene, true);

  const polled = await pairedDisplays.pollNextRender(db, display.id, token, now);
  assert.equal(polled.event.kind, 'scene');
  const doc = polled.event.scene.srcdoc;
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /connect-src 'none'/);
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('Bleed a radiator</h1>'));
  assert.ok(doc.includes(html));

  const plain = await pairedDisplays.queueRender(db, 'user-1', { displayId: display.id, title: 'Dinner', body: '7:30pm', now });
  await pairedDisplays.acknowledgeRender(db, display.id, token, event.id, now);
  const next = await pairedDisplays.pollNextRender(db, display.id, token, now);
  assert.equal(next.event.id, plain.id);
  assert.equal(Object.hasOwn(next.event, 'scene'), false);
});

test('a scene cannot reach outside, read the page around it, or carry secrets', async () => {
  const displayScene = require('../../api/services/display-scene');
  const attempts = [
    '<img src="https://evil.example/x.png">',
    '<a href="//evil.example">go</a>',
    '<iframe src="about:blank"></iframe>',
    '<script src="app.js"></script>',
    '<style>@import url(https://evil.example/a.css);</style>',
    '<div style="background:url(https://evil.example/p)"></div>',
    '<script>fetch("/agent/home")</script>',
    '<script>new XMLHttpRequest()</script>',
    '<script>navigator.sendBeacon("/x")</script>',
    '<script>window.parent.postMessage("x","*")</script>',
    '<script>document.cookie</script>',
    '<script>localStorage.getItem("milgrain_display_token")</script>',
    '<script>location.href = "https://evil.example"</script>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<form action="/x"><button>Go</button></form>',
    '<p>Authorization: Bearer sk-live-secret-value</p>',
    '<a href="javascript:alert(1)">x</a>'
  ];
  for (const html of attempts) {
    assert.throws(() => displayScene.validateSceneHtml(html), error => error.code === 'invalid_content', `accepted: ${html}`);
  }
  assert.throws(() => displayScene.validateSceneHtml('x'.repeat(displayScene.MAX_SCENE_HTML + 1)), /too large/);
  assert.throws(() => displayScene.validateSceneHtml('   '), /needs some content/);
  assert.throws(() => displayScene.validateSceneHtml({ html: 'x' }), /HTML text/);
  const fine = '<p>Stir from the top. Then wait.</p><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
  assert.equal(displayScene.validateSceneHtml(fine), fine);

  const db = fakeSupabase();
  const challenge = await pairedDisplays.createPairingChallenge(db, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  });
  const { display } = await pairedDisplays.redeemPairingChallenge(db, {
    challengeId: challenge.id, code: challenge.code, now, randomBytes: deterministicRandom
  });
  await assert.rejects(
    () => pairedDisplays.queueRender(db, 'user-1', {
      displayId: display.id, title: 'Hi', body: 'Hello', sceneHtml: '<img src="https://evil.example/x.png">', now
    }),
    error => error.code === 'invalid_content'
  );
  assert.equal(db.tables.display_render_events.length, 0);
});

test('Adam can read back what a screen is showing so it can change it', async () => {
  const db = fakeSupabase();
  const challenge = await pairedDisplays.createPairingChallenge(db, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  });
  const { display } = await pairedDisplays.redeemPairingChallenge(db, {
    challengeId: challenge.id, code: challenge.code, now, randomBytes: deterministicRandom
  });
  assert.equal(await pairedDisplays.currentScene(db, 'user-1', display.id), null);

  await pairedDisplays.queueRender(db, 'user-1', {
    displayId: display.id, title: 'First', body: 'one', sceneHtml: '<p>one</p>', now
  });
  await pairedDisplays.queueRender(db, 'user-1', { displayId: display.id, title: 'Note', body: 'plain', now });
  const latest = await pairedDisplays.queueRender(db, 'user-1', {
    displayId: display.id, title: 'Bigger', body: 'two', sceneHtml: '<p class="title">two</p>', now
  });
  const current = await pairedDisplays.currentScene(db, 'user-1', display.id);
  assert.equal(current.title, 'Bigger');
  assert.equal(current.sceneHtml, '<p class="title">two</p>');
  assert.equal(new Date(db.tables.display_render_events.find(row => row.id === latest.id).expires_at).getTime(),
    now.getTime() + pairedDisplays.SCENE_TTL_MS);

  await assert.rejects(() => pairedDisplays.currentScene(db, 'someone-else', display.id), /not paired/);
});

test('a tap on a screen can ask for things but can never approve or cancel', () => {
  const displayAsk = require('../../api/services/display-ask');
  displayAsk._reset();
  assert.equal(displayAsk.validateDisplayAsk('  Show me   the next step '), 'Show me the next step');
  assert.equal(displayAsk.validateDisplayAsk('Order the usual from Boots'), 'Order the usual from Boots');
  for (const word of ['yes', 'confirm', 'Yes please', 'go ahead', 'book it', 'approve', 'cancel', 'not yet', 'never mind']) {
    assert.throws(() => displayAsk.validateDisplayAsk(word), error => error.code === 'needs_phone', `allowed: ${word}`);
  }
  assert.throws(() => displayAsk.validateDisplayAsk(''), error => error.code === 'invalid_ask');
  assert.throws(() => displayAsk.validateDisplayAsk({ a: 1 }), error => error.code === 'invalid_ask');
  assert.throws(() => displayAsk.validateDisplayAsk('x'.repeat(displayAsk.MAX_ASK + 1)), /too long/);

  displayAsk.checkAskRate('d1', 1000);
  assert.throws(() => displayAsk.checkAskRate('d1', 1000 + displayAsk.MIN_GAP_MS - 1), error => error.code === 'too_fast');
  displayAsk.checkAskRate('d1', 1000 + displayAsk.MIN_GAP_MS);
  displayAsk.checkAskRate('d2', 1000);
});

test('the scene wrapper gives pages one way to ask Adam, and nothing else', () => {
  const displayScene = require('../../api/services/display-scene');
  const doc = displayScene.buildSceneDocument('<button class="btn" data-ask="Next step">Next</button>');
  assert.match(doc, /window\.adam=\{ask:send\}/);
  assert.match(doc, /data-ask/);
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<script>'));
  assert.throws(() => displayScene.validateSceneHtml('<script>window.parent.postMessage({adamAsk:"yes"},"*")</script>'));
  assert.throws(() => displayScene.validateSceneHtml('<script>self.parent.postMessage("x","*")</script>'));
});
