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


function pairedDisplayFixture() {
  const db = fakeSupabase();
  return pairedDisplays.createPairingChallenge(db, 'user-1', {
    baseUrl: 'https://oxy.example', now, randomBytes: deterministicRandom
  }).then(challenge => pairedDisplays.redeemPairingChallenge(db, {
    challengeId: challenge.id, code: challenge.code, now, randomBytes: deterministicRandom
  })).then(({ display, token }) => ({ db, display, token }));
}

const radiatorScene = () => ({
  title: 'Bleed a radiator',
  visual: {
    things: [
      { id: 'rad', type: 'piece', piece: 'radiator', label: 'Radiator' },
      { id: 'valve', type: 'piece', piece: 'valve', label: 'Bleed valve', accent: true },
      { id: 'air', type: 'flow', from: 'valve', to: 'rad' }
    ]
  },
  panel: [{ id: 'steps', type: 'steps', items: ['Heating off', 'Quarter turn', 'Close it'] }],
  beats: [
    { say: 'Turn the heating off first.', do: [{ verb: 'show', id: 'rad' }, { verb: 'step', id: 'steps', n: 1 }] },
    { say: 'Find the valve.', do: [{ verb: 'show', id: 'valve' }, { verb: 'focus', id: 'valve' }, { verb: 'step', id: 'steps', n: 2 }] },
    { say: 'A quarter turn lets the air out.', do: [{ verb: 'turn', id: 'valve', deg: 90 }, { verb: 'flow', id: 'air' }] }
  ],
  asks: ['Where is the valve on mine?']
});

test('a scene is stored as data and rendered by Adam, never as markup from the model', async () => {
  const { db, display, token } = await pairedDisplayFixture();
  const event = await pairedDisplays.queueRender(db, 'user-1', {
    displayId: display.id, title: 'Bleed a radiator', body: 'Four steps.', scene: radiatorScene(), now
  });
  assert.equal(event.kind, 'scene');
  assert.equal(event.scene, true);
  const stored = db.tables.display_render_events.find(row => row.id === event.id);
  assert.equal(stored.payload.scene.spec.title, 'Bleed a radiator');
  assert.equal(Object.hasOwn(stored.payload.scene, 'html'), false);
  assert.equal(new Date(stored.expires_at).getTime(), now.getTime() + pairedDisplays.SCENE_TTL_MS);

  const polled = await pairedDisplays.pollNextRender(db, display.id, token, now);
  const doc = polled.event.scene.srcdoc;
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /id="spec"/);
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('id="spec"'));

  const plain = await pairedDisplays.queueRender(db, 'user-1', { displayId: display.id, title: 'Dinner', body: '7:30pm', now });
  await pairedDisplays.acknowledgeRender(db, display.id, token, event.id, now);
  const next = await pairedDisplays.pollNextRender(db, display.id, token, now);
  assert.equal(next.event.id, plain.id);
  assert.equal(Object.hasOwn(next.event, 'scene'), false);
});

test('scene text can never become markup or script on the page', () => {
  const sceneRuntime = require('../../api/services/scene-runtime');
  const evil = '</script><script>fetch("https://evil.example")</script><img src=x onerror=alert(1)>';
  const doc = sceneRuntime.buildSpecDocument({
    title: evil,
    visual: { things: [{ id: 'a', type: 'piece', piece: 'radiator', label: evil }] },
    panel: [{ id: 't', type: 'text', text: evil }],
    beats: [{ say: evil }]
  });
  assert.equal((doc.match(/<script/g) || []).length, 3, 'only the two bridges and the renderer run');
  assert.equal(doc.includes('</script><script>fetch'), false);
  assert.equal(doc.includes('<img src=x'), false);
  assert.match(doc, /\\u003c\/script\\u003e/);
});

test('the scene format turns away what is not allowed, and says why', () => {
  const { validateScene } = require('../../api/services/scene-spec');
  const good = radiatorScene();
  assert.equal(validateScene(good).beats.length, 3);
  assert.equal(validateScene(JSON.stringify(good)).title, 'Bleed a radiator');

  const bad = (mutate, pattern) => {
    const scene = radiatorScene();
    mutate(scene);
    assert.throws(() => validateScene(scene), pattern);
  };
  bad(s => { s.visual.things[0].piece = 'radiator valve key'; }, /no piece called radiator valve key/);
  bad(s => { delete s.visual.things[0].id; }, /needs an id/);
  bad(s => { s.visual.things[1].id = 'rad'; }, /used twice/);
  bad(s => { s.visual.things.push({ id: 'x', type: 'arrow', from: 'rad', to: 'nothing' }); }, /must go from one piece's id/);
  bad(s => { s.visual.things.push({ id: 'c', type: 'circle', at: [10, 10], size: 5 }); }, /unknown type "circle"/);
  bad(s => { s.beats[0].do[0].id = 'ghost'; }, /nothing called "ghost"/);
  bad(s => { s.beats[0].do[0] = { verb: 'count', id: 'rad', value: 3 }; }, /works on number/);
  bad(s => { s.beats[0].do[0] = { verb: 'explode', id: 'rad' }; }, /unknown verb/);
  bad(s => { s.beats[0].say = 'word '.repeat(60); }, /too long/);
  bad(s => { s.beats = []; }, /beats needs/);
  bad(s => { s.visual.things = Array.from({ length: 9 }, (_, k) => ({ id: `p${k}`, type: 'piece', piece: 'clock' })); }, /up to 8 pieces/);
  bad(s => { s.panel[0].items = []; }, /needs 1 to 8/);
  assert.throws(() => validateScene('not json'), /JSON object/);
  assert.throws(() => validateScene({ title: 'x', beats: [{ say: 'hi' }] }), /visual, a panel, or both/);

  const clean = validateScene({ title: ' Hi ', panel: [{ id: 't', type: 'text', text: 'a   b', extra: 'dropped' }], beats: [{ say: 'ok', evil: 1 }] });
  assert.equal(clean.panel[0].text, 'a b');
  assert.equal(Object.hasOwn(clean.panel[0], 'extra'), false);
  assert.equal(Object.hasOwn(clean.beats[0], 'evil'), false);
  const timeline = validateScene({ title: 't', panel: [{ id: 'tl', type: 'timeline', items: [{ label: 'a', from: '9:05' }] }], beats: [{ say: 'ok' }] });
  assert.equal(timeline.panel[0].items[0].from, '09:05');
  assert.throws(() => validateScene({ title: 't', panel: [{ id: 'tl', type: 'timeline', items: [{ label: 'a', from: '25:99' }] }], beats: [{ say: 'ok' }] }), /24-hour time/);
});

test('Adam can read back the scene a screen is showing so it can change it', async () => {
  const { db, display } = await pairedDisplayFixture();
  assert.equal(await pairedDisplays.currentScene(db, 'user-1', display.id), null);
  await pairedDisplays.queueRender(db, 'user-1', { displayId: display.id, title: 'First', body: 'one', scene: radiatorScene(), now });
  await pairedDisplays.queueRender(db, 'user-1', { displayId: display.id, title: 'Note', body: 'plain', now });
  const bigger = radiatorScene();
  bigger.title = 'Bigger';
  await pairedDisplays.queueRender(db, 'user-1', { displayId: display.id, title: 'Bigger', body: 'two', scene: bigger, now });
  const current = await pairedDisplays.currentScene(db, 'user-1', display.id);
  assert.equal(current.title, 'Bigger');
  assert.equal(current.scene.title, 'Bigger');
  await assert.rejects(() => pairedDisplays.currentScene(db, 'someone-else', display.id), /not paired/);
});

test('show_scene makes a page for the phone, and refuses a scene that is not allowed', async () => {
  const { handlers } = require('../../api/actions/display');
  const ok = await handlers.show_scene({ params: { title: 'Bleed a radiator', body: 'Four steps.', scene: radiatorScene() } });
  assert.equal(ok.success, true);
  assert.equal(ok.scene.title, 'Bleed a radiator');
  assert.match(ok.scene.srcdoc, /connect-src 'none'/);
  assert.match(ok.scene.srcdoc, /window\.adam=/);
  const bad = await handlers.show_scene({ params: { title: 'x', scene: { title: 'x', beats: [] } } });
  assert.equal(bad.success, false);
  assert.equal(Object.hasOwn(bad, 'scene'), false);
  assert.equal((await handlers.show_scene({ params: { title: 'x' } })).success, false);
});

test('the model is told about every piece and verb, and a bad scene never reaches a screen', async () => {
  const kit = require('../../api/services/display-scene-kit');
  const { VERBS } = require('../../api/services/scene-spec');
  const contract = require('../../api/action-contracts').getActionContract('show_scene');
  for (const name of kit.PIECE_NAMES.filter(n => !['play', 'pause', 'replay'].includes(n))) {
    assert.ok(contract.paramHints.scene.includes(`"${name}"`), `the model is not told about ${name}`);
  }
  for (const verb of VERBS) assert.ok(contract.paramHints.scene.includes(verb), `the model is not told about ${verb}`);
  for (const name of kit.PIECE_NAMES) assert.ok(kit.SPRITE.includes(`id="p-${name}"`), name);

  const { db, display } = await pairedDisplayFixture();
  await assert.rejects(
    () => pairedDisplays.queueRender(db, 'user-1', { displayId: display.id, title: 'x', body: 'y', scene: { title: 'x', beats: [] }, now }),
    error => error.code === 'invalid_content'
  );
  assert.equal(db.tables.display_render_events.length, 0);
});
