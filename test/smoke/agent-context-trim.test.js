const test = require('node:test');
const assert = require('node:assert/strict');
const { modelView, compactStaleObservations, STALE_NOTE } = require('../../api/services/agent-context-trim');

const page = (n) => ({
  success: true, url: `https://shop.example/${n}`, pageTitle: `Page ${n}`,
  elements: Array.from({ length: 60 }, (_, i) => `#${i} "Control ${i}"`),
  pageText: 'x'.repeat(4000),
  text: `Page ${n}\n\nControls:\n${'#0 "Control"\n'.repeat(60)}\n\nPage text:\n${'x'.repeat(2000)}`,
  note: 'The page changed after that step.', changed: { url: true },
});
const turn = (name, result) => ({ role: 'function', parts: [{ functionResponse: { name, response: { result: JSON.stringify(result) } } }] });

test('the model sees each page once: the duplicate control list and raw text are dropped', () => {
  const view = modelView(page(1));
  assert.equal('elements' in view, false);
  assert.equal('pageText' in view, false);
  assert.match(view.text, /Controls:/);
  assert.equal(view.url, 'https://shop.example/1');
  assert.ok(JSON.stringify(view).length < JSON.stringify(page(1)).length / 1.8);
});

test('results that are not page observations pass through untouched', () => {
  const email = { success: true, messages: [{ id: 1 }], text: 'three emails' };
  assert.deepEqual(modelView(email), email);
  assert.equal(modelView(null), null);
});

test('only the newest page stays in full; earlier pages shrink to a pointer', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'buy it' }] },
    turn('browser_open', modelView(page(1))),
    turn('browser_act', modelView(page(2))),
    turn('browser_act', modelView(page(3))),
  ];
  compactStaleObservations(contents);
  const results = contents.slice(1).map((c) => JSON.parse(c.parts[0].functionResponse.response.result));
  assert.equal(results[0].note, STALE_NOTE);
  assert.equal(results[1].note, STALE_NOTE);
  assert.equal(results[0].url, 'https://shop.example/1');
  assert.equal(results[2].note, 'The page changed after that step.');
  assert.match(results[2].text, /Controls:/);
});

test('non-browser results between pages are left alone, and compaction is repeatable', () => {
  const email = { success: true, text: 'e'.repeat(1000), messages: [] };
  const contents = [turn('browser_open', modelView(page(1))), turn('send_email', email), turn('browser_act', modelView(page(2)))];
  compactStaleObservations(contents);
  compactStaleObservations(contents);
  assert.equal(JSON.parse(contents[1].parts[0].functionResponse.response.result).text, email.text);
  assert.equal(JSON.parse(contents[0].parts[0].functionResponse.response.result).note, STALE_NOTE);
  assert.match(JSON.parse(contents[2].parts[0].functionResponse.response.result).text, /Controls:/);
});
