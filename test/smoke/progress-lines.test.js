const assert = require('node:assert/strict');
const test = require('node:test');

const { progressLine, PROGRESS_LINES } = require('../../api/services/progress-lines');
const { ACTION_CONTRACTS } = require('../../api/action-contracts');

const contractNames = Array.isArray(ACTION_CONTRACTS)
  ? ACTION_CONTRACTS.map((c) => c.name)
  : Object.keys(ACTION_CONTRACTS);

test('every action the model can call has its own progress line', () => {
  const missing = contractNames.filter((name) => !PROGRESS_LINES[name]);
  assert.deepEqual(missing, [], 'these would show only the bare working mark');
});

test('lines are plain words, never internal names or raw values', () => {
  for (const name of contractNames) {
    const contract = Array.isArray(ACTION_CONTRACTS) ? ACTION_CONTRACTS.find((c) => c.name === name) : ACTION_CONTRACTS[name];
    for (const input of [{}, contract.inputExample || {}]) {
      const line = progressLine(name, input);
      assert.ok(line && line !== 'Working on it', `${name} fell back to the generic line`);
      assert.doesNotMatch(line, /_|\{|https?:|@/, `${name}: ${line}`);
      assert.ok(line.length <= 60, `${name} is too long for the pill: ${line}`);
    }
  }
});

test('lines name the specific thing when the input carries one', () => {
  assert.equal(progressLine('search_emails', { query: 'Lisbon' }), 'Searching your email for Lisbon');
  assert.equal(progressLine('find_people', { query: 'Ada' }), 'Looking up Ada');
  assert.equal(progressLine('browser_open', { url: 'https://www.argos.co.uk/basket' }), 'Opening argos.co.uk');
});

test('addresses, numbers, dates and long text never leak into a line', () => {
  assert.equal(progressLine('send_email', { to: 'ada@example.com' }), 'Sending your email');
  assert.equal(progressLine('send_message', { contact: '+447700900123' }), 'Writing your message');
  assert.equal(progressLine('create_reminder', { title: '2026-10-08T18:00' }), 'Setting a reminder');
  assert.ok(progressLine('web_search', { query: 'x'.repeat(200) }).endsWith('…'));
});

test('unknown actions and bad input degrade to a plain phrase', () => {
  assert.equal(progressLine('some_new_action', {}), 'Working on it');
  assert.equal(progressLine('search_emails', null), 'Searching your email');
  assert.equal(progressLine('search_emails', { query: { nested: true } }), 'Searching your email');
});
