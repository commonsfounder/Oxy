const assert = require('node:assert/strict');
const test = require('node:test');

const { getRuntimeVersion } = require('../../api/services/runtime-version');

test('runtime version exposes deploy proof fields', () => {
  const version = getRuntimeVersion();
  assert.equal(version.app, 'oxy');
  assert.ok(version.packageVersion);
  assert.ok(version.gitCommit);
  assert.ok(version.gitBranch);
  assert.ok(version.buildTime);
  assert.ok(version.nodeVersion);
  assert.ok(Object.hasOwn(version, 'environment'));
});
