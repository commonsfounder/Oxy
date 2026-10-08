const test = require('node:test');
const assert = require('node:assert/strict');
const { validateScene } = require('../../api/services/scene-spec');
const { handlers } = require('../../api/actions/display');
const { buildSpecDocument } = require('../../api/services/scene-runtime');

const fixture = () => ({ title: 'Choose a route', mode: 'interface', panel: [
  { id: 'routes', type: 'compare', items: [
    { title: 'Direct', facts: [{ label: 'Price', value: '£54' }], ask: 'Explore the direct route' },
    { title: 'One change', facts: [{ label: 'Price', value: '£38' }], ask: 'Explore the one-change route' }
  ] },
  { id: 'details', type: 'form', fields: [{ id: 'budget', label: 'Budget', type: 'number', required: true }], submit: 'Find options', ask: 'Find options using these details' }
] });

test('one capability returns checked, native interface data and an offline fallback', async () => {
  const result = await handlers.show_scene({ params: { title: 'Choose a route', scene: fixture() } });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.scene.spec, validateScene(fixture()));
  assert.match(result.scene.srcdoc, /connect-src 'none'/);
  assert.match(result.scene.srcdoc, /form-action 'none'/);
  assert.match(result.scene.srcdoc, /window\.adam\.ask/);
  assert.ok(!result.scene.srcdoc.includes('setInterval('), 'interactive UI must not play a narrated scene');
});

test('interface composition is independent of the human task', () => {
  for (const panel of [
    [{ id: 'tasks', type: 'steps', items: ['Pack charger', 'Pack passport'] }],
    [{ id: 'options', type: 'choices', items: [{ title: 'Morning', detail: 'Before work', ask: 'Find a morning appointment' }] }],
    [{ id: 'comparison', type: 'table', columns: ['Item', 'Price'], rows: [['A', '£20'], ['B', 'Unknown']] }],
    [{ id: 'plan', type: 'timeline', items: [{ label: 'Leave', from: '10:00' }] }]
  ]) assert.equal(validateScene({ title: 'Task', mode: 'interface', panel }).panel.length, 1);
});

test('generated controls cannot supply approval or cancellation', () => {
  for (const request of ['yes', 'go ahead', 'approve payment', 'cancel', 'book it']) {
    for (const type of ['choices', 'compare', 'form', 'asks']) {
      const scene = fixture();
      if (type === 'asks') scene.asks = [request];
      else if (type === 'form') scene.panel[1].ask = request;
      else if (type === 'compare') scene.panel[0].items[0].ask = request;
      else scene.panel = [{ id: 'pick', type, items: [{ title: 'Next', ask: request }] }];
      assert.throws(() => validateScene(scene), /Approve or cancel/, `${type}: ${request}`);
    }
  }
});

test('interface schema rejects unsupported controls, malformed tables and duplicate fields', () => {
  const bad = panel => ({ title: 'Task', mode: 'interface', panel });
  assert.throws(() => validateScene(bad([{ id: 'x', type: 'table', columns: ['A', 'B'], rows: [['A']] }])), /match the headings/);
  const scene = fixture();
  scene.panel[1].fields.push(scene.panel[1].fields[0]);
  assert.throws(() => validateScene(scene), /unique lowercase id/);
  scene.panel[1].fields = [{ id: 'secret', label: 'Password', type: 'password' }];
  assert.throws(() => validateScene(scene), /protected flows/);
  scene.panel[1].fields = [{ id: 'password', label: 'Password', type: 'text' }];
  assert.throws(() => validateScene(scene), /protected flows/);
  assert.throws(() => validateScene(bad([{ id: 'x', type: 'timer', secs: 30 }])), /real reminder/);
  assert.throws(() => validateScene({ ...fixture(), beats: [] }), /without visual or beats/);
  assert.throws(() => validateScene({ ...fixture(), mode: 'explainer', beats: [{ say: 'Hello', do: [] }] }), /need mode: interface/);
});

test('interface text is inert, including script terminators in rows and fields', () => {
  const evil = '</script><script>window.stolen=true</script>';
  const scene = fixture();
  scene.panel[1].fields[0].label = evil;
  const doc = buildSpecDocument(scene);
  assert.ok(!doc.includes(evil));
  assert.match(doc, /\\u003c\/script\\u003e/);
  assert.match(doc, /textContent=text/);
  assert.ok(!require('../../api/services/task-interface').JS.includes('innerHTML'));
});

test('a refused interface never comes back as a completed action', async () => {
  const scene = fixture();
  scene.panel[1].ask = 'yes';
  const result = await handlers.show_scene({ params: { scene } });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.scene, undefined);
});
