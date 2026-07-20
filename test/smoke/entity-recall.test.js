const assert = require('node:assert/strict');
const test = require('node:test');

const { extractReferentialPhrase, resolveEntityReference } = require('../../api/services/entity-recall');

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
  const supabase = {
    from() {
      return {
        select() {
          return { eq(col, val) { return { order: async () => ({ data: rows.filter((r) => r[col] === val), error: null }) }; } };
        }
      };
    }
  };
  const result = await resolveEntityReference(supabase, 'u1', 'find the candidate I opened yesterday');
  assert.equal(result.entityName, 'Jane Doe');
  assert.equal(result.site, 'linkedin.com');
});
