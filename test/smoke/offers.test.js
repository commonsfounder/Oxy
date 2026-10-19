const assert = require('node:assert/strict');
const test = require('node:test');
const { chooseOffer } = require('../../api/services/offers');

const NOW = new Date('2026-10-19T10:00:00Z');

test('a birthday this week becomes one offer with a ready-made yes', () => {
  const offer = chooseOffer({ now: NOW, occasions: [{ person_name: 'Alisa', occasion_type: 'birthday', month: 10, day: 22 }], commitments: [] });
  assert.match(offer.text, /Alisa's birthday is in 3 days/);
  assert.match(offer.prompt, /gift/);
  assert.equal(offer.id.startsWith('occasion:alisa'), true);
});

test('nothing is offered for dates that are far away', () => {
  assert.equal(chooseOffer({ now: NOW, occasions: [{ person_name: 'Alisa', occasion_type: 'birthday', month: 12, day: 1 }], commitments: [] }), null);
});

test('an open commitment that is due soon is offered, and the most pressing wins', () => {
  const offer = chooseOffer({
    now: NOW,
    occasions: [{ person_name: 'Alisa', occasion_type: 'birthday', month: 10, day: 24 }],
    commitments: [{ id: 'c1', what: 'send the tenancy documents', due_at: '2026-10-20T10:00:00Z', status: 'open' }]
  });
  assert.match(offer.text, /send the tenancy documents/);
  assert.equal(offer.prompt, 'Help me finish this: send the tenancy documents.');
});

test('something already offered is not offered again', () => {
  const args = { now: NOW, occasions: [{ person_name: 'Alisa', occasion_type: 'birthday', month: 10, day: 22 }], commitments: [] };
  const first = chooseOffer(args);
  assert.equal(chooseOffer({ ...args, alreadyOffered: new Set([first.id]) }), null);
});

test('done or far-overdue commitments are left alone', () => {
  const offer = chooseOffer({ now: NOW, occasions: [], commitments: [
    { id: 'a', what: 'old thing', due_at: '2026-10-01T10:00:00Z', status: 'open' },
    { id: 'b', what: 'finished thing', due_at: '2026-10-20T10:00:00Z', status: 'done' }
  ] });
  assert.equal(offer, null);
});
