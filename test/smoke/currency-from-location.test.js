const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveCurrencyForLocation } = require('../../api/services/currency-from-location');

test('resolveCurrencyForLocation defaults to usd with no location', () => {
  assert.equal(resolveCurrencyForLocation(null), 'usd');
  assert.equal(resolveCurrencyForLocation(undefined), 'usd');
  assert.equal(resolveCurrencyForLocation({}), 'usd');
});

test('resolveCurrencyForLocation maps London to gbp, not the wider eur box', () => {
  assert.equal(resolveCurrencyForLocation({ latitude: 51.5072, longitude: -0.1276 }), 'gbp');
});

test('resolveCurrencyForLocation maps Paris to eur', () => {
  assert.equal(resolveCurrencyForLocation({ latitude: 48.8566, longitude: 2.3522 }), 'eur');
});

test('resolveCurrencyForLocation maps Toronto to cad', () => {
  assert.equal(resolveCurrencyForLocation({ lat: 43.6532, lng: -79.3832 }), 'cad');
});

test('resolveCurrencyForLocation maps Sydney to aud', () => {
  assert.equal(resolveCurrencyForLocation({ latitude: -33.8688, longitude: 151.2093 }), 'aud');
});

test('resolveCurrencyForLocation maps New York to usd', () => {
  assert.equal(resolveCurrencyForLocation({ latitude: 40.7128, longitude: -74.006 }), 'usd');
});

test('resolveCurrencyForLocation falls back to usd for coordinates outside any known box', () => {
  assert.equal(resolveCurrencyForLocation({ latitude: 1.3521, longitude: 103.8198 }), 'usd');
});

test('resolveCurrencyForLocation ignores non-finite coordinates', () => {
  assert.equal(resolveCurrencyForLocation({ latitude: 'nope', longitude: 'nah' }), 'usd');
});
