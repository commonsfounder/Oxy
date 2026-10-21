const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCards, splitVerb, brandIn } = require('../../api/services/home-feed');

const NOW = new Date('2026-10-21T10:00:00Z');

test('a sentence becomes a verb pill and the rest', () => {
  assert.deepEqual(splitVerb('Want me to add the Sunday Market to your calendar?'), { verb: 'Add', rest: 'the Sunday Market to your calendar?' });
  assert.equal(brandIn('pay Monzo tonight'), 'monzo');
  assert.equal(brandIn('pay the council'), null);
});

test('real dates and commitments become cards, most urgent first, with a ready request behind each', () => {
  const cards = buildCards({
    now: NOW,
    occasions: [{ person_name: 'Alisa', occasion_type: 'birthday', month: 10, day: 24 }],
    commitments: [{ id: 'c1', what: 'send the tenancy documents', due_at: '2026-10-22T10:00:00Z', status: 'open' }],
    photoOffers: [{ id: 'photo:abc', ask: 'Want me to add the Sunday Market to your calendar?', prompt: 'Add the Sunday Market to my calendar.' }]
  });
  assert.equal(cards[0].verb, 'Send');
  assert.match(cards[0].rest, /tenancy documents\? Due tomorrow/);
  assert.equal(cards.length, 3);
  assert.ok(cards.every(c => c.prompt && c.id));
  assert.equal(cards.find(c => c.verb === 'Plan').rest.includes('Alisa'), true);
});

test('done, far-off or overdue-for-ages items are left off', () => {
  const cards = buildCards({
    now: NOW,
    occasions: [{ person_name: 'Bo', occasion_type: 'birthday', month: 12, day: 1 }],
    commitments: [
      { id: 'a', what: 'old thing', due_at: '2026-09-01T10:00:00Z', status: 'open' },
      { id: 'b', what: 'finished thing', due_at: '2026-10-22T10:00:00Z', status: 'done' }
    ]
  });
  assert.equal(cards.length, 0);
});
