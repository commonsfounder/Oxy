'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assessLookupCompletion } = require('../../api/services/browser-completion');

test('a price lookup completes only with the requested product and a displayed price', () => {
  const result = assessLookupCompletion({
    goal: 'find the current UK starting price of the iPhone 16',
    searchTerm: 'iPhone 16',
    text: 'iPhone 16, 128GB — £799',
  });
  assert.deepEqual(result, { complete: true, missing: [] });
});

test('a checkout CTA is not evidence for a price lookup', () => {
  const result = assessLookupCompletion({
    goal: 'find the Galaxy S25 Ultra and report its price and storage options',
    searchTerm: 'Galaxy S25 Ultra',
    text: 'Ready to Buy now',
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['matching item', 'price', 'storage options']);
});

test('a multi-fact lookup requires every requested fact', () => {
  const result = assessLookupCompletion({
    goal: 'find a grey corner sofa and report its price and dimensions',
    searchTerm: 'grey corner sofa',
    text: 'Grey corner sofa — £899',
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['dimensions']);
});

test('a train lookup requires route evidence and a departure time', () => {
  const result = assessLookupCompletion({
    goal: 'find the next train from Birmingham Moor Street to London Marylebone and report its departure time',
    searchTerm: 'Birmingham Moor Street London Marylebone',
    text: 'Birmingham Moor Street to London Marylebone departs at 09:12.',
  });
  assert.deepEqual(result, { complete: true, missing: [] });
});

test('availability lookup does not complete without an availability state', () => {
  const result = assessLookupCompletion({
    goal: 'find the Nintendo Switch OLED and report its price and stock status',
    searchTerm: 'Nintendo Switch OLED',
    text: 'Nintendo Switch OLED — £299.99',
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['availability']);
});

test('an answer that admits it could not verify the result never completes', () => {
  const result = assessLookupCompletion({
    goal: 'find the next train from Birmingham Moor Street to London Marylebone and report its departure time',
    searchTerm: 'Birmingham Moor Street London Marylebone',
    text: 'I could not verify the next train from Birmingham Moor Street to London Marylebone. A page mentioned 09:12.',
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['verified result']);
});
