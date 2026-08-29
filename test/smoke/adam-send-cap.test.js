const assert = require('node:assert/strict');
const test = require('node:test');

const { checkAdamSendCap } = require('../../api/index');

test('checkAdamSendCap allows sending when under the daily cap', async () => {
  const result = await checkAdamSendCap.__testOverride(async () => 3, 'demo-test-user', 'email');
  assert.equal(result.allowed, true);
});

test('checkAdamSendCap blocks sending at or above the daily cap', async () => {
  const oldCap = process.env.MILLIE_DAILY_SEND_CAP;
  process.env.MILLIE_DAILY_SEND_CAP = '5';
  try {
    const result = await checkAdamSendCap.__testOverride(async () => 5, 'demo-test-user', 'email');
    assert.equal(result.allowed, false);
    assert.match(result.message, /today/i);
  } finally {
    if (oldCap === undefined) delete process.env.MILLIE_DAILY_SEND_CAP;
    else process.env.MILLIE_DAILY_SEND_CAP = oldCap;
  }
});
