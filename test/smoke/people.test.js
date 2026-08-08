// Pure identity-resolution and formatting logic for the people layer
// (api/services/people.js). The database-backed behaviour — real merges, corrections,
// occasion linking — is covered in people-orchestration.test.js against real Supabase.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeEmail,
  normalizePhone,
  rankNameCandidates,
  decideNameMatch,
  shouldReplaceDisplayName,
  formatProfile,
  formatPeopleSummary,
  peopleContextLine
} = require('../../api/services/people');

const james = { id: '1', display_name: 'James Whitfield', relationship: 'tutor' };
const jamesTwo = { id: '2', display_name: 'James Okafor', relationship: 'colleague' };
const alisa = { id: '3', display_name: 'Alisa', relationship: 'girlfriend' };

test('an email address is only accepted as a handle when it is actually one', () => {
  assert.equal(normalizeEmail('  Alisa@Example.COM '), 'alisa@example.com');
  assert.equal(normalizeEmail('not an email'), '');
  assert.equal(normalizeEmail('alisa@example'), '');
});

test('phone handles compare by digits, so formatting differences are one handle not two', () => {
  assert.equal(normalizePhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalizePhone('(07700) 900-123'), '07700900123');
  assert.equal(normalizePhone('12'), '', 'too short to be a real number');
});

test('an exact name beats a partial one', () => {
  const ranked = rankNameCandidates([james, alisa], 'alisa');
  assert.deepEqual(ranked.exact.map(p => p.id), ['3']);
  assert.equal(ranked.partial.length, 0);
});

test('a first name matches a full name, but only as a partial', () => {
  const ranked = rankNameCandidates([james], 'James');
  assert.equal(ranked.exact.length, 0);
  assert.deepEqual(ranked.partial.map(p => p.id), ['1']);
});

test('a single first-name hit resolves; two of them are an ambiguity, never a coin flip', () => {
  const one = decideNameMatch([james, alisa], 'James');
  assert.equal(one.person.id, '1');
  assert.equal(one.match, 'partial_name');

  const two = decideNameMatch([james, jamesTwo], 'James');
  assert.equal(two.person, null);
  assert.equal(two.ambiguous, true);
  assert.deepEqual(two.candidates.map(p => p.id), ['1', '2']);
});

test('two people with the identical stored name are also an ambiguity, not a merge', () => {
  const decided = decideNameMatch(
    [{ id: 'a', display_name: 'James' }, { id: 'b', display_name: 'James' }],
    'James'
  );
  assert.equal(decided.ambiguous, true);
  assert.equal(decided.candidates.length, 2);
});

test('a name nobody matches resolves to nothing rather than the closest guess', () => {
  const decided = decideNameMatch([james, alisa], 'Mia');
  assert.equal(decided.person, null);
  assert.equal(decided.ambiguous, undefined);
});

test('a substring that is not a name boundary does not match', () => {
  // "Ali" must not silently resolve to "Alisa" — the caller passing a partial word is not
  // evidence of identity.
  const decided = decideNameMatch([alisa], 'Ali');
  assert.equal(decided.person, null);
});

test('a real name replaces an address that was standing in as one', () => {
  assert.equal(shouldReplaceDisplayName('james@example.com', 'James Whitfield'), true);
  assert.equal(shouldReplaceDisplayName('+447700900123', 'Alisa'), true);
  // Length is explicitly not the rule — an email address is usually the longer string.
  assert.ok('james@example.com'.length > 'James Whitfield'.length);
});

test('a name the user gave is never overwritten by an unrelated one', () => {
  assert.equal(shouldReplaceDisplayName('James Whitfield', 'James Okafor'), false);
  assert.equal(shouldReplaceDisplayName('Alisa', 'Mia'), false);
  assert.equal(shouldReplaceDisplayName('James Whitfield', 'james@example.com'), false);
});

test('a fuller version of the same name does replace it', () => {
  assert.equal(shouldReplaceDisplayName('James', 'James Whitfield'), true);
  assert.equal(shouldReplaceDisplayName('James Whitfield', 'James'), false);
  assert.equal(shouldReplaceDisplayName('Alisa', 'alisa'), false, 'case-only differences are not a change');
});

test('a profile reads as a person, not a record dump', () => {
  const line = formatProfile({
    name: 'Alisa', relationship: 'girlfriend', businessName: null,
    emails: ['alisa@example.com'], phones: [],
    facts: [{ fact: 'prefers gold jewellery' }], occasions: []
  });
  assert.equal(line, 'Alisa — your girlfriend — alisa@example.com — prefers gold jewellery');
});

test('an empty lookup says so instead of returning an empty shape', () => {
  assert.match(formatPeopleSummary([], { query: 'Mia' }), /don't have anyone saved as "Mia"/);
  assert.match(formatPeopleSummary([], {}), /don't have anyone saved yet/);
});

test('an ambiguous lookup asks which one', () => {
  const text = formatPeopleSummary(
    [
      { name: 'James Whitfield', relationship: 'tutor', emails: [], phones: [], facts: [], occasions: [] },
      { name: 'James Okafor', relationship: 'colleague', emails: [], phones: [], facts: [], occasions: [] }
    ],
    { ambiguous: true, query: 'James' }
  );
  assert.match(text, /More than one person matches "James"/);
  assert.match(text, /Which one\?/);
});

test('the live-context roster carries names and relationships only, never stored facts', () => {
  const line = peopleContextLine([
    { display_name: 'Alisa', relationship: 'girlfriend' },
    { display_name: 'Ben', relationship: 'manager' },
    { display_name: 'Sainsbury\'s support', relationship: null }
  ]);
  assert.equal(line, "Alisa (girlfriend), Ben (manager), Sainsbury's support");
});

test('the live-context roster is capped so it cannot crowd out the rest of the prompt', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ display_name: `Person ${i}`, relationship: null }));
  assert.equal(peopleContextLine(many).split(', ').length, 12);
});
