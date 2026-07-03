'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isSearchResultsUrl, isGuestCheckoutUrl } = require('../../api/services/browser-task');

test('isSearchResultsUrl recognises common retailer search URLs', () => {
  assert.equal(isSearchResultsUrl('https://www.wickes.co.uk/search?text=white+paint'), true);
  assert.equal(isSearchResultsUrl('https://www.johnlewis.com/search?search-term=joggers'), true);
  assert.equal(isSearchResultsUrl('https://www.amazon.co.uk/s?k=milk'), true);
  assert.equal(isSearchResultsUrl('https://www.wickes.co.uk/Crown-Paint/p/166844'), false);
  assert.equal(isSearchResultsUrl('https://www.wickes.co.uk/cart'), false);
});

test('isGuestCheckoutUrl recognises login-or-guest and guest checkout paths', () => {
  assert.equal(isGuestCheckoutUrl('https://checkout.wickes.co.uk/login-or-guest'), true);
  assert.equal(isGuestCheckoutUrl('https://www.marksandspencer.com/checkout/guest'), true);
  assert.equal(isGuestCheckoutUrl('https://www.wickes.co.uk/Crown-Paint/p/166844'), false);
});