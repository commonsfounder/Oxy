const assert = require('node:assert/strict');
const test = require('node:test');

const { shouldSuppressVisionClick, findVariantSelectionHint } = require('../../api/services/browser-task');

// Regression for the ubereats.com reliability-benchmark failure: the primary add-to-order
// button ("Add 1 to order • £12.99") carries a price and was misclassified as an unrelated
// cross-sell tile once the cart went non-empty, so the loop suppressed it every turn until
// the step cap. The allowlist needed "order" alongside checkout/basket/bag/cart/trolley/
// continue/delivery/payment.
test('shouldSuppressVisionClick: a priced "Add to order" button is not suppressed as upsell once cart is non-empty', () => {
  const session = { cartEverNonzero: true };
  assert.equal(shouldSuppressVisionClick(session, 'Add 1 to order • £12.99'), false);
});

test('shouldSuppressVisionClick: an unrelated priced cross-sell tile is still suppressed once cart is non-empty', () => {
  const session = { cartEverNonzero: true };
  assert.equal(shouldSuppressVisionClick(session, 'You might also like — Running socks £8.00'), true);
});

// Regression for the asos.com reliability-benchmark failure: the model repeated "ADD TO BAG"
// 6+ times without ever selecting a size. A real screenshot of the stuck page (2026-08-04)
// showed the actual required control was a "Please select" size dropdown — its own text
// never says "size" at all, so a naive text-match on /size/ can't find it. Worse, that naive
// match instead picked "Size & Fit", an unrelated info accordion at the bottom of the page,
// and hinting the model toward it did nothing — confirmed live, the model never acted on it.
// Tier 1 (unfilled placeholder) must win over tier 2 (name contains "size") for this reason.
test('findVariantSelectionHint: an unfilled "Please select" dropdown wins over a same-page "Size & Fit" info accordion', () => {
  const session = { cartEverNonzero: false };
  const elements = [
    { text: 'ADD TO BAG' },
    { text: 'Find your Fit Assistant size' }, // suppressed elsewhere — must not be picked
    { text: 'Please select' }, // the real, unfilled size <select> — no "size" in its own text
    { text: 'Size & Fit' }, // an info accordion, not a selector — must lose to the placeholder
    { text: 'Delivery & Returns' },
  ];
  assert.equal(findVariantSelectionHint(session, elements), 'Please select');
});

test('findVariantSelectionHint: falls back to a named size/colour control when no placeholder is present', () => {
  const session = { cartEverNonzero: false };
  const elements = [{ text: 'ADD TO BAG' }, { text: 'Colour: Indigo' }, { text: 'Delivery & Returns' }];
  assert.equal(findVariantSelectionHint(session, elements), 'Colour: Indigo');
});

test('findVariantSelectionHint: never falls back to a "Size & Fit" / "Size Guide" info accordion', () => {
  const session = { cartEverNonzero: false };
  const elements = [{ text: 'ADD TO BAG' }, { text: 'Size & Fit' }, { text: 'Size Guide' }];
  assert.equal(findVariantSelectionHint(session, elements), null);
});

test('findVariantSelectionHint: returns null when no variant control is present', () => {
  const session = { cartEverNonzero: false };
  const elements = [{ text: 'ADD TO BAG' }, { text: 'Delivery & Returns' }];
  assert.equal(findVariantSelectionHint(session, elements), null);
});

test('findVariantSelectionHint: never returns a suppressed candidate even if it text-matches "size"', () => {
  const session = { cartEverNonzero: false };
  const elements = [{ text: 'Find your Fit Assistant size' }];
  assert.equal(findVariantSelectionHint(session, elements), null);
});
