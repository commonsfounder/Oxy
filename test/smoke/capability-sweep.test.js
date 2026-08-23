const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_READS,
  runCapabilitySweep
} = require('../../api/services/capability-sweep');

test('capability sweep runs the safe household reads in a stable order', async () => {
  const calls = [];
  const result = await runCapabilitySweep({
    userId: 'user-1',
    execute: async (action, input) => {
      calls.push({ action, input });
      return { success: true, outcome: 'completed', text: `${action} complete` };
    }
  });

  assert.deepEqual(calls.map(call => call.action), DEFAULT_READS.map(item => item.action));
  assert.equal(result.success, true);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.coverage.total, DEFAULT_READS.length);
  assert.equal(result.coverage.completed, DEFAULT_READS.length);
  assert.equal(result.coverage.failed, 0);
  assert.equal(result.skipped.some(item => item.key === 'weather'), true);
  assert.equal(result.skipped.some(item => item.key === 'travel'), true);
});

test('capability sweep keeps going and reports an honest partial result after a failed read', async () => {
  const calls = [];
  const result = await runCapabilitySweep({
    userId: 'user-1',
    execute: async (action) => {
      calls.push(action);
      if (action === 'get_emails') return { success: false, outcome: 'unavailable', error: 'Gmail is not connected.' };
      return { success: true, outcome: 'completed' };
    }
  });

  assert.equal(calls.length, DEFAULT_READS.length);
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.coverage.failed, 1);
  assert.equal(result.results.find(item => item.action === 'get_emails').result.error, 'Gmail is not connected.');
  assert.equal(result.results.at(-1).action, DEFAULT_READS.at(-1).action);
});

test('capability sweep adds requested read-only searches and never invents missing targets', async () => {
  const calls = [];
  const result = await runCapabilitySweep({
    userId: 'user-1',
    inputs: {
      weather_city: 'London',
      place_query: 'quiet coffee near Kings Cross',
      stock_symbol: 'AAPL'
    },
    execute: async (action, input) => {
      calls.push({ action, input });
      return { success: true, outcome: 'completed' };
    }
  });

  assert.deepEqual(calls.slice(-3), [
    { action: 'get_weather', input: { city: 'London' } },
    { action: 'find_place', input: { query: 'quiet coffee near Kings Cross' } },
    { action: 'get_stock_price', input: { symbol: 'AAPL' } }
  ]);
  assert.equal(result.skipped.some(item => item.key === 'travel'), true);
  assert.equal(result.skipped.some(item => item.key === 'directions'), true);
});
