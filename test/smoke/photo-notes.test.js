const assert = require('node:assert/strict');
const test = require('node:test');
const photoNotes = require('../../api/services/photo-notes');
const photos = require('../../api/actions/photos');

function fakeDb() {
  const rows = [];
  let id = 0;
  function from() {
    let filters = [], mode = 'select', slice = null;
    const api = {
      select() { return api; },
      insert(list) { for (const r of [].concat(list)) rows.push({ id: ++id, ...r }); return Promise.resolve({ error: null }); },
      delete() { mode = 'delete'; return api; },
      eq(c, v) { filters.push(r => r[c] === v); return api; },
      in(c, vs) { filters.push(r => vs.includes(r[c])); return api; },
      order() { return api; }, limit() { return api; }, range(a, b) { slice = [a, b + 1]; return api; },
      then(res, rej) {
        let hit = rows.filter(r => filters.every(f => f(r)));
        if (slice) hit = hit.slice(slice[0], slice[1]);
        if (mode === 'delete') hit.forEach(h => rows.splice(rows.indexOf(h), 1));
        return Promise.resolve({ data: hit, error: null }).then(res, rej);
      }
    };
    return api;
  }
  return { from, rows };
}

test('long digit runs are blanked before a note is stored', () => {
  assert.match(photoNotes.noteLine({ text: 'Card 4111 1111 1111 1111 on a receipt from Boots', date: '2026-10-03T10:00:00Z' }), /Card \[number\] on a receipt/);
  assert.equal(photoNotes.noteLine({ text: '123' }), '');
});

test('notes are saved once, kept apart from other memories, and can be wiped', async () => {
  const db = fakeDb();
  db.rows.push({ id: 99, user_id: 'u1', source: 'fact', content: 'Likes tea' });
  const batch = [{ text: 'Letter from the council: bill of 84 pounds due 3 November', date: '2026-10-03' }, { text: 'Letter from the council: bill of 84 pounds due 3 November', date: '2026-10-03' }];
  assert.equal((await photoNotes.saveNotes(db, 'u1', batch)).saved, 1);
  assert.equal((await photoNotes.saveNotes(db, 'u1', batch)).saved, 0);
  await photoNotes.forgetAll(db, 'u1');
  assert.deepEqual(db.rows.map(r => r.content), ['Likes tea']);
});

test('search finds the matching note and says so when nothing matches', async () => {
  const db = fakeDb();
  await photoNotes.saveNotes(db, 'u1', [{ text: 'Flyer for Sunday market at the Bullring with live music' }, { text: 'Receipt from Boots for shampoo and toothpaste' }]);
  const hit = await photos.handlers.search_photos({ userId: 'u1', params: { query: 'market bullring' }, deps: { supabase: db } });
  assert.match(hit.text, /Sunday market/);
  const miss = await photos.handlers.search_photos({ userId: 'u1', params: { query: 'passport' }, deps: { supabase: db } });
  assert.equal(miss.items.length, 0);
  assert.match(miss.text, /haven't seen/);
});

test('a photo is described once, sensitive ones are skipped, and nothing but the note comes back', async () => {
  const { describePhoto, buildPrompt } = require('../../api/services/photo-vision');
  const ok = await describePhoto({ generate: async () => ({ text: 'A red two-piece set on a hanger, about 3 people in the room.' }), image: Buffer.from('x'), context: { date: '2026-10-15' } });
  assert.match(ok.note, /red two-piece set/);
  const skipped = await describePhoto({ generate: async () => ({ text: 'SKIP' }), image: Buffer.from('x') });
  assert.equal(skipped.skipped, true);
  assert.equal((await describePhoto({ generate: async () => ({ text: 'x' }), image: Buffer.alloc(800 * 1024) })).reason, 'too_large');
  assert.match(buildPrompt({ text: 'VS set' }), /VS set/);
});
