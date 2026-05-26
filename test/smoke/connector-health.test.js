const assert = require('node:assert/strict');
const test = require('node:test');

const {
  connectorForAction,
  diagnoseConnectorIssue,
  humanConnectorName
} = require('../../api/services/connector-health');

test('connector health maps core actions to owning connector', () => {
  assert.equal(connectorForAction('send_email'), 'google');
  assert.equal(connectorForAction('search_emails'), 'google');
  assert.equal(connectorForAction('find_place'), 'maps');
  assert.equal(connectorForAction('book_uber'), 'uber');
  assert.equal(connectorForAction('search_trains'), 'trainline');
});

test('connector health turns auth failures into reconnect recovery', () => {
  const diagnosis = diagnoseConnectorIssue(
    { type: 'send_email', input: { to: 'josh@example.com', body: 'Hi' } },
    { success: false, error: 'Google not connected: token expired. Reconnect Google from Settings.' }
  );

  assert.equal(diagnosis.connectorId, 'google');
  assert.equal(diagnosis.healthStatus, 'needs_reconnect');
  assert.equal(diagnosis.recoveryAction.type, 'open_connector_settings');
  assert.equal(diagnosis.recoveryAction.connectorId, 'google');
  assert.match(diagnosis.cardText, /Reconnect Google/);
});

test('connector health turns permission failures into permission recovery', () => {
  const diagnosis = diagnoseConnectorIssue(
    { type: 'search_trains', input: { origin: 'Milton Keynes Central', destination: 'Birmingham New Street' } },
    { success: false, error: 'Trainline error: access denied by current rail data permissions' }
  );

  assert.equal(diagnosis.connectorId, 'trainline');
  assert.equal(diagnosis.healthStatus, 'permission_blocked');
  assert.match(diagnosis.cardText, /permissions/);
});

test('connector health turns transient failures into retry recovery', () => {
  const action = { type: 'get_emails', input: { max_results: 5 } };
  const diagnosis = diagnoseConnectorIssue(action, {
    success: false,
    error: 'Google error: timeout'
  });

  assert.equal(diagnosis.healthStatus, 'temporarily_unavailable');
  assert.deepEqual(diagnosis.recoveryAction, { type: 'retry_action', action });
  assert.equal(diagnosis.retryable, true);
});

test('connector health names user-facing connector brands', () => {
  assert.equal(humanConnectorName('ubereats'), 'Uber Eats');
  assert.equal(humanConnectorName('trainline'), 'Trainline');
});
