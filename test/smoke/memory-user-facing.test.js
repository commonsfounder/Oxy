const assert = require('node:assert/strict');
const test = require('node:test');

// index.js builds real service clients at load; give them harmless values so the
// module imports without reaching out to anything.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const { isUserFacingMemory } = require('../../api/index.js');

test('excludes internal agent_episodic rows', () => {
  assert.equal(isUserFacingMemory({ source: 'agent_episodic' }), false);
});

test('includes manual_profile rows', () => {
  assert.equal(isUserFacingMemory({ source: 'manual_profile' }), true);
});

test('includes fact rows', () => {
  assert.equal(isUserFacingMemory({ source: 'fact' }), true);
});

test('includes rows with undefined source', () => {
  assert.equal(isUserFacingMemory({ source: undefined }), true);
});
