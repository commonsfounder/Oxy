const assert = require('node:assert/strict');
const test = require('node:test');

const { extractReferentialPhrase, hasBareEntityReference, resolveEntityReference, REFERENTIAL_SUBSTITUTION_PATTERN } = require('../../api/services/entity-recall');

// Real Supabase applies .order() server-side; this fixture must too, or a "most recent"
// query would only be correct by accident of insertion order.
function fakeEntitySupabase(rows) {
  return {
    from() {
      return {
        select() {
          return {
            eq(col, val) {
              return {
                order: async () => ({
                  data: rows.filter((r) => r[col] === val).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
                  error: null
                })
              };
            }
          };
        }
      };
    }
  };
}

test('extractReferentialPhrase matches "the X I opened yesterday" style phrases', () => {
  assert.equal(extractReferentialPhrase('find the candidate I opened yesterday and prep interview notes'), 'candidate');
  assert.equal(extractReferentialPhrase('what is the weather today'), null);
});

test('extractReferentialPhrase matches "that X" style phrases', () => {
  assert.equal(extractReferentialPhrase('add that product to my list'), 'product');
});

test('extractReferentialPhrase returns null for ordinary messages', () => {
  assert.equal(extractReferentialPhrase('order a medium black t-shirt from Rothys'), null);
});

test('resolveEntityReference returns null when no phrase matches', async () => {
  const result = await resolveEntityReference({}, 'u1', 'what time is it');
  assert.equal(result, null);
});

test('resolveEntityReference returns null when a phrase matches but no entity is found', async () => {
  const supabase = {
    from() {
      return { select() { return { eq() { return { order: async () => ({ data: [], error: null }) }; } }; } };
    }
  };
  const result = await resolveEntityReference(supabase, 'u1', 'add that product to my list');
  assert.equal(result, null);
});

test('resolveEntityReference returns the matched entity when a phrase and a stored entity both exist', async () => {
  const rows = [{ user_id: 'u1', entity_name: 'Jane Doe', entity_type: 'candidate', site: 'linkedin.com', created_at: new Date().toISOString() }];
  const supabase = fakeEntitySupabase(rows);
  const result = await resolveEntityReference(supabase, 'u1', 'find the candidate I opened yesterday');
  assert.equal(result.entityName, 'Jane Doe');
  assert.equal(result.site, 'linkedin.com');
});

test('hasBareEntityReference requires a commerce verb or price question alongside the pronoun', () => {
  assert.equal(hasBareEntityReference('add it to my basket'), true);
  assert.equal(hasBareEntityReference('order that now'), true);
  assert.equal(hasBareEntityReference('how much is it'), true);
  assert.equal(hasBareEntityReference('what time is it'), false);
  assert.equal(hasBareEntityReference('is it going to rain today'), false);
});

test('resolveEntityReference resolves a bare pronoun ("add it to my basket") to the most recent entity', async () => {
  const rows = [
    { user_id: 'u1', entity_name: 'Older Jacket', entity_type: 'product', site: 'asos.com', created_at: new Date(Date.now() - 3600000).toISOString() },
    { user_id: 'u1', entity_name: 'Adidas Joggers', entity_type: 'product', site: 'johnlewis.com', created_at: new Date().toISOString() }
  ];
  const supabase = fakeEntitySupabase(rows);
  const result = await resolveEntityReference(supabase, 'u1', 'add it to my basket');
  assert.equal(result.entityName, 'Adidas Joggers');
  assert.equal(result.site, 'johnlewis.com');
});

test('resolveEntityReference does not resolve a bare pronoun with no commerce context', async () => {
  const rows = [{ user_id: 'u1', entity_name: 'Adidas Joggers', entity_type: 'product', site: 'johnlewis.com', created_at: new Date().toISOString() }];
  const supabase = fakeEntitySupabase(rows);
  const result = await resolveEntityReference(supabase, 'u1', 'what time is it');
  assert.equal(result, null);
});

test('REFERENTIAL_SUBSTITUTION_PATTERN rewrites the bare pronoun span so routing sees the real product', () => {
  const rewritten = 'add it to my basket'.replace(REFERENTIAL_SUBSTITUTION_PATTERN, '"Adidas Joggers" (from johnlewis.com)');
  assert.equal(rewritten, 'add "Adidas Joggers" (from johnlewis.com) to my basket');
});
