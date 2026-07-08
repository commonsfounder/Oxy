const assert = require('node:assert/strict');
const test = require('node:test');

// index.js builds real service clients at load; give them harmless values so the
// module imports without reaching out to anything.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const { isUserFacingMemory, isUsefulMemoryContent } = require('../../api/index.js');

test('excludes internal agent_episodic rows', () => {
  assert.equal(isUserFacingMemory({ source: 'agent_episodic', content: 'Booked the train' }), false);
});

test('includes manual_profile rows', () => {
  assert.equal(isUserFacingMemory({ source: 'manual_profile', content: 'Lives in Birmingham' }), true);
});

test('includes fact rows', () => {
  assert.equal(isUserFacingMemory({ source: 'fact', content: 'Works at KPMG' }), true);
});

test('includes rows with undefined source', () => {
  assert.equal(isUserFacingMemory({ source: undefined, content: 'Prefers quiet mornings' }), true);
});

test('excludes internal trace-looking rows even if source is missing', () => {
  assert.equal(isUserFacingMemory({ source: undefined, content: 'Agent handled goal ~ buy milk (trace agent-1783132449182)' }), false);
});

test('excludes low-signal memory garbage', () => {
  assert.equal(isUsefulMemoryContent('huh'), false);
  assert.equal(isUsefulMemoryContent('ok'), false);
  assert.equal(isUserFacingMemory({ source: 'fact', content: 'My home is huh' }), false);
});

test('excludes malformed quote snippets', () => {
  assert.equal(isUsefulMemoryContent('Calls a loved one "pookie'), false);
});
