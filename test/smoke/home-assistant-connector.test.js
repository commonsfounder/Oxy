const assert = require('node:assert/strict');
const test = require('node:test');

const {
  commandToService,
  executeConfigured,
  homeAssistantConfig,
  resolveEntityId
} = require('../../connectors/home-assistant');

test('Home Assistant maps explicit entity ids and aliases without guessing', () => {
  const env = {
    HOME_ASSISTANT_ENTITY_LIVING_ROOM: 'light.living_room',
    HOME_ASSISTANT_ENTITY_MAP: JSON.stringify({ bedroom: 'switch.bedroom_lamp' })
  };
  assert.equal(resolveEntityId('light.kitchen', env), 'light.kitchen');
  assert.equal(resolveEntityId('living room', env), 'light.living_room');
  assert.equal(resolveEntityId('bedroom', env), 'switch.bedroom_lamp');
  assert.equal(resolveEntityId('unknown', env), null);
});

test('Home Assistant allow-lists simple services and climate temperature changes', () => {
  assert.deepEqual(commandToService('light.living_room', 'on'), {
    domain: 'light', service: 'turn_on', data: { entity_id: 'light.living_room' }
  });
  assert.deepEqual(commandToService('climate.downstairs', 'set 21.5'), {
    domain: 'climate', service: 'set_temperature', data: { entity_id: 'climate.downstairs', temperature: 21.5 }
  });
  assert.match(commandToService('lock.front_door', 'on').error, /does not support/i);
  assert.match(commandToService('light.living_room', 'open').error, /supported/i);
});

test('Home Assistant verifies the state after an accepted service call', async () => {
  const calls = [];
  const request = {
    post: async (...args) => { calls.push(['post', ...args]); },
    get: async (...args) => { calls.push(['get', ...args]); return { data: { state: 'on' } }; }
  };
  const result = await executeConfigured({
    config: { baseUrl: 'http://home.local', token: 'secret' },
    device: 'light.living_room',
    command: 'on',
    request
  });
  assert.equal(result.success, true);
  assert.equal(result.state, 'on');
  assert.equal(calls[0][1], 'http://home.local/api/services/light/turn_on');
  assert.equal(calls[1][1], 'http://home.local/api/states/light.living_room');
  assert.equal(calls[0][2].entity_id, 'light.living_room');
  assert.equal(calls[0][3].headers.Authorization, 'Bearer secret');
});

test('Home Assistant reports accepted-but-unverified commands as incomplete', async () => {
  const result = await executeConfigured({
    config: { baseUrl: 'http://home.local', token: 'secret' },
    device: 'light.living_room',
    command: 'off',
    request: {
      post: async () => {},
      get: async () => { throw new Error('connection reset'); }
    }
  });
  assert.equal(result.success, false);
  assert.equal(result.executed, true);
  assert.equal(result.outcome, 'failed');
  assert.match(result.error, /could not verify/i);
});

test('Home Assistant is explicitly unavailable without both server settings', () => {
  assert.equal(homeAssistantConfig({ HOME_ASSISTANT_URL: 'http://home.local' }), null);
  assert.deepEqual(homeAssistantConfig({ HOME_ASSISTANT_URL: 'http://home.local', HOME_ASSISTANT_TOKEN: 'secret' }), {
    baseUrl: 'http://home.local', token: 'secret'
  });
});
