const assert = require('node:assert/strict');
const test = require('node:test');

const { executeAction } = require('../../api/index');

test('send_millie_sms requires to and body', async () => {
  const result = await executeAction('demo-test-user', 'send_millie_sms', { body: 'hi' }, {});
  assert.equal(result.success, false);
  assert.equal(result.error, 'send_millie_sms requires a recipient phone number and a message');
});
