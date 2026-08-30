'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { passesLayerOneGauntlet } = require('../../test/dev/capability-stress');

test('Layer 1 gauntlet requires a completed effect or a correct authority boundary', () => {
  for (const status of ['completed', 'approval_boundary', 'browser_boundary']) {
    assert.equal(passesLayerOneGauntlet({ status }), true, status);
  }
  for (const status of ['setup_blocked', 'handoff_required', 'setup_or_handoff', 'wrong_route', 'effect_risk', 'failed']) {
    assert.equal(passesLayerOneGauntlet({ status }), false, status);
  }
});
