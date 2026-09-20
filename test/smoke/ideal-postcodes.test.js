const assert = require('node:assert/strict');
const test = require('node:test');
const { lookupHomeAddresses } = require('../../api/services/ideal-postcodes');

test('postcode search uses Ideal Postcodes and returns only safe address suggestions', async () => {
  const calls = [];
  const postcodeLookup = async ({ postcode }) => {
    calls.push(postcode);
    return [{
      udprn: 123,
      line_1: '10 Downing Street',
      post_town: 'London',
      postcode: 'SW1A 2AA'
    }];
  };

  const addresses = await lookupHomeAddresses('sw1a2aa', { apiKey: 'test-key', postcodeLookup });
  assert.equal(calls.length, 1);
  assert.deepEqual(addresses, [{ id: '123', address: '10 Downing Street, London, SW1A 2AA' }]);
});

test('unconfigured Ideal Postcodes lookup fails explicitly', async () => {
  await assert.rejects(
    () => lookupHomeAddresses('SW1A 2AA', { apiKey: '' }),
    { code: 'ADDRESS_LOOKUP_NOT_CONFIGURED' }
  );
});
