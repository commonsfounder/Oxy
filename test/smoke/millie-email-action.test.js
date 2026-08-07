const assert = require('node:assert/strict');
const test = require('node:test');

const { executeAction } = require('../../api/index');

test('send_millie_email requires to and body', async () => {
  const result = await executeAction('demo-test-user', 'send_millie_email', { body: 'hi' }, {});
  assert.equal(result.success, false);
  assert.equal(result.error, 'send_millie_email requires a recipient and a message');
});
