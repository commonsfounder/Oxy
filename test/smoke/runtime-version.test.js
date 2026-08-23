const assert = require('node:assert/strict');
const test = require('node:test');

const { getRuntimeVersion } = require('../../api/services/runtime-version');

test('runtime version exposes deploy proof fields', () => {
  const version = getRuntimeVersion();
  assert.equal(version.app, 'oxy');
  assert.ok(version.packageVersion);
  assert.ok(version.gitCommit);
  assert.ok(version.gitBranch);
  assert.ok(Object.hasOwn(version, 'platform'));
  assert.ok(version.deployId);
  assert.ok(version.buildTime);
  assert.ok(version.nodeVersion);
  assert.ok(Object.hasOwn(version, 'environment'));
});

test('runtime version reports immutable Fly release provenance supplied at image build', () => {
  const version = getRuntimeVersion({
    NODE_ENV: 'production',
    OXY_COMMIT_SHA: '8a4eae9d1bf1',
    OXY_GIT_BRANCH: 'main',
    OXY_BUILD_TIME: '2026-08-16T12:00:00.000Z',
    FLY_APP_NAME: 'milgrain-live-2026',
    FLY_REGION: 'lhr'
  });

  assert.equal(version.gitCommit, '8a4eae9d1bf1');
  assert.equal(version.gitBranch, 'main');
  assert.equal(version.buildTime, '2026-08-16T12:00:00.000Z');
  assert.equal(version.platform, 'fly');
  assert.equal(version.flyApp, 'milgrain-live-2026');
  assert.equal(version.region, 'lhr');
  assert.equal(version.deployId, '8a4eae9d1bf1');
});
