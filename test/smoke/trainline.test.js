const assert = require('node:assert/strict');
const test = require('node:test');

const trainline = require('../../connectors/trainline');

test('Apsley resolves through the train fallback path without failing', async () => {
  const oldId = process.env.TRANSPORT_API_APP_ID;
  const oldKey = process.env.TRANSPORT_API_APP_KEY;
  delete process.env.TRANSPORT_API_APP_ID;
  delete process.env.TRANSPORT_API_APP_KEY;
  try {
    const result = await trainline.execute('test-user', 'search_trains', {
      origin: 'Birmingham New Street',
      destination: 'Apsley'
    });
    assert.equal(result.success, true);
    assert.match(result.webLink, /birmingham\/aps/);
    assert.match(result.text, /live rail data isn't configured/i);
  } finally {
    if (oldId) process.env.TRANSPORT_API_APP_ID = oldId;
    if (oldKey) process.env.TRANSPORT_API_APP_KEY = oldKey;
  }
});

test('unknown stations degrade to Trainline instead of a failed action', async () => {
  const oldId = process.env.TRANSPORT_API_APP_ID;
  const oldKey = process.env.TRANSPORT_API_APP_KEY;
  delete process.env.TRANSPORT_API_APP_ID;
  delete process.env.TRANSPORT_API_APP_KEY;
  try {
    const result = await trainline.execute('test-user', 'search_trains', {
      origin: 'Milton Keynes Central',
      destination: 'Definitely Not A Station'
    });
    assert.equal(result.success, true);
    assert.equal(result.actionSummary, 'Trainline ready');
    assert.match(result.webLink, /milton-keynes-central\/definitely-not-a-station/);
    assert.match(result.text, /couldn't verify/i);
  } finally {
    if (oldId) process.env.TRANSPORT_API_APP_ID = oldId;
    if (oldKey) process.env.TRANSPORT_API_APP_KEY = oldKey;
  }
});
