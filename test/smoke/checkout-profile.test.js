'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyCheckoutAsk,
  findEmailInputElement,
  parseEmailFromUserText,
  parseCheckoutReplyFromUserText,
  wantsSaveDetailsConsent,
  wantsSaveEmailConsent,
  buildEmailAskWithConsent,
  buildDetailsAskWithConsent,
  matchProfileFieldForInput,
  loadCheckoutProfile,
  saveCheckoutProfile,
  saveCheckoutEmail,
} = require('../../api/services/checkout-profile');

// --------------- classifyCheckoutAsk ---------------

test('classifyCheckoutAsk returns email for clear guest-checkout email asks', () => {
  for (const q of [
    'Please provide an email address for the guest checkout',
    'What is your email?',
    'Enter your email address to continue',
  ]) {
    assert.equal(classifyCheckoutAsk(q), 'email', q);
  }
});

test('classifyCheckoutAsk returns name for full-name / delivery-name asks', () => {
  for (const q of [
    'Please enter your full name',
    'Your first name',
    'Name for the order',
    'Name for the delivery',
  ]) {
    assert.equal(classifyCheckoutAsk(q), 'name', q);
  }
});

test('classifyCheckoutAsk returns phone for contact-number asks', () => {
  for (const q of [
    'Enter your mobile number',
    'Your phone number',
    'Contact number required',
    'What is your mobile?',
  ]) {
    assert.equal(classifyCheckoutAsk(q), 'phone', q);
  }
});

test('classifyCheckoutAsk returns address for delivery-address asks', () => {
  for (const q of [
    'What delivery address should I use?',
    'Enter your shipping address',
    'Please provide your address line 1',
    'What is your postcode?',
    'Enter your house number and street',
  ]) {
    assert.equal(classifyCheckoutAsk(q), 'address', q);
  }
});

test('classifyCheckoutAsk never classifies payment fields', () => {
  for (const q of [
    'Enter your card number',
    'What are your payment details?',
    'CVV required',
    'Enter your sort code',
    'Account number',
  ]) {
    assert.equal(classifyCheckoutAsk(q), null, q);
  }
});

test('classifyCheckoutAsk returns null for truly ambiguous asks', () => {
  assert.equal(classifyCheckoutAsk('Which size would you like?'), null);
  assert.equal(classifyCheckoutAsk(''), null);
});

// --------------- findEmailInputElement ---------------

test('findEmailInputElement matches email-labelled inputs only', () => {
  const elements = [
    { id: 0, text: 'Email address', locatorIndex: 3 },
    { id: 1, text: 'Card number', locatorIndex: 4 },
    { id: 2, text: 'Continue', locatorIndex: 5 },
  ];
  const found = findEmailInputElement(elements);
  assert.equal(found.id, 0);
  assert.equal(found.locatorIndex, 3);
});

// --------------- parseEmailFromUserText ---------------

test('parseEmailFromUserText extracts and normalises an email', () => {
  assert.equal(parseEmailFromUserText('use john@Example.COM please'), 'john@example.com');
  assert.equal(parseEmailFromUserText('no email here'), null);
});

// --------------- parseCheckoutReplyFromUserText ---------------

test('parseCheckoutReplyFromUserText extracts email, name, address and phone from a full reply', () => {
  const result = parseCheckoutReplyFromUserText(
    'Chizi M, 12 High Street, London, SW1A 1AA, 07700 900123'
  );
  assert.equal(result.name, 'Chizi M');
  assert.equal(result.address.line1, '12 High Street');
  assert.equal(result.address.city, 'London');
  assert.equal(result.address.postcode, 'SW1A 1AA');
  assert.equal(result.phone, '07700 900123');
});

test('parseCheckoutReplyFromUserText handles email in reply', () => {
  const result = parseCheckoutReplyFromUserText('test@example.com save my details');
  assert.equal(result.email, 'test@example.com');
});

test('parseCheckoutReplyFromUserText handles partial address without city', () => {
  const result = parseCheckoutReplyFromUserText('42 Acacia Avenue, SW1A 1AA');
  assert.equal(result.address.line1, '42 Acacia Avenue');
  assert.equal(result.address.postcode, 'SW1A 1AA');
});

test('parseCheckoutReplyFromUserText returns empty object on low-confidence input', () => {
  const result = parseCheckoutReplyFromUserText('yes please');
  assert.deepEqual(result, {});
});

test('parseCheckoutReplyFromUserText handles +44 phone', () => {
  const result = parseCheckoutReplyFromUserText('+447700 900123');
  assert.equal(result.phone, '+447700 900123');
});

test('parseCheckoutReplyFromUserText handles line2 when present', () => {
  const result = parseCheckoutReplyFromUserText('Chizi M, Flat 3, 12 High Street, London, SW1A 1AA');
  assert.equal(result.name, 'Chizi M');
  assert.equal(result.address.line1, '12 High Street');
  assert.equal(result.address.line2, 'Flat 3');
  assert.equal(result.address.city, 'London');
  assert.equal(result.address.postcode, 'SW1A 1AA');
});

// --------------- wantsSaveDetailsConsent / wantsSaveEmailConsent ---------------

test('wantsSaveDetailsConsent detects broad save phrases', () => {
  assert.equal(wantsSaveDetailsConsent('save my details'), true);
  assert.equal(wantsSaveDetailsConsent('save my address'), true);
  assert.equal(wantsSaveDetailsConsent('save my email'), true);
  assert.equal(wantsSaveDetailsConsent('save my information'), true);
  assert.equal(wantsSaveDetailsConsent('just continue'), false);
});

test('wantsSaveEmailConsent is an alias that still works', () => {
  assert.equal(wantsSaveEmailConsent('save my email'), true);
  assert.equal(wantsSaveEmailConsent('no thanks'), false);
});

// --------------- buildDetailsAskWithConsent / buildEmailAskWithConsent ---------------

test('buildDetailsAskWithConsent includes missing fields and consent line once', () => {
  const q = buildDetailsAskWithConsent('What delivery details should I use?', ['name', 'address', 'postcode']);
  assert.match(q, /name/i);
  assert.match(q, /save my details/i);
  assert.equal(buildDetailsAskWithConsent(q, ['name', 'address', 'postcode']), q);
});

test('buildEmailAskWithConsent still appends save instruction once', () => {
  const q = buildEmailAskWithConsent('What email for guest checkout?');
  assert.match(q, /save my/i);
  assert.equal(buildEmailAskWithConsent(q), q);
});

// --------------- matchProfileFieldForInput ---------------

test('matchProfileFieldForInput maps email hints', () => {
  assert.equal(matchProfileFieldForInput('email address'), 'email');
  assert.equal(matchProfileFieldForInput('e-mail'), 'email');
});

test('matchProfileFieldForInput maps name hints', () => {
  assert.equal(matchProfileFieldForInput('full name'), 'full_name');
  assert.equal(matchProfileFieldForInput('first name'), 'first_name');
  assert.equal(matchProfileFieldForInput('last name'), 'last_name');
  assert.equal(matchProfileFieldForInput('surname'), 'last_name');
  assert.equal(matchProfileFieldForInput('given name'), 'first_name');
  assert.equal(matchProfileFieldForInput('family name'), 'last_name');
});

test('matchProfileFieldForInput maps phone hints', () => {
  assert.equal(matchProfileFieldForInput('mobile number'), 'phone');
  assert.equal(matchProfileFieldForInput('phone'), 'phone');
  assert.equal(matchProfileFieldForInput('tel'), 'phone');
  assert.equal(matchProfileFieldForInput('contact number'), 'phone');
});

test('matchProfileFieldForInput maps address hints', () => {
  assert.equal(matchProfileFieldForInput('address line 1'), 'line1');
  assert.equal(matchProfileFieldForInput('address line 2'), 'line2');
  assert.equal(matchProfileFieldForInput('city'), 'city');
  assert.equal(matchProfileFieldForInput('town'), 'city');
  assert.equal(matchProfileFieldForInput('postcode'), 'postcode');
  assert.equal(matchProfileFieldForInput('zip code'), 'postcode');
  assert.equal(matchProfileFieldForInput('post code'), 'postcode');
  assert.equal(matchProfileFieldForInput('street'), 'line1');
  assert.equal(matchProfileFieldForInput('house number'), 'line1');
});

test('matchProfileFieldForInput returns null for payment and unknown hints', () => {
  assert.equal(matchProfileFieldForInput('card number'), null);
  assert.equal(matchProfileFieldForInput('cvv'), null);
  assert.equal(matchProfileFieldForInput('sort code'), null);
  assert.equal(matchProfileFieldForInput('something random'), null);
  assert.equal(matchProfileFieldForInput(''), null);
});

// --------------- loadCheckoutProfile / saveCheckoutProfile ---------------

function makeStubSupabase(rows = []) {
  const upserted = [];
  const deleted = [];
  const stub = {
    _upserted: upserted,
    _deleted: deleted,
    from(table) {
      return {
        select(cols) {
          return {
            eq() { return this; },
            like() { return this; },
            in() { return this; },
            async maybeSingle() { return { data: rows[0] || null, error: null }; },
            then(resolve) { return Promise.resolve({ data: rows, error: null }).then(resolve); },
          };
        },
        upsert(data) {
          upserted.push(data);
          return { onConflict() { return Promise.resolve({ error: null }); } };
        },
        delete() {
          return {
            like(col, val) { deleted.push(val); return Promise.resolve({ error: null }); },
          };
        },
      };
    },
  };
  return stub;
}

test('loadCheckoutProfile returns nulls when no prefs stored', async () => {
  const supabase = makeStubSupabase([]);
  const profile = await loadCheckoutProfile(supabase, 'user1');
  assert.equal(profile.email, null);
  assert.equal(profile.name, null);
  assert.equal(profile.phone, null);
  assert.equal(profile.address, null);
  assert.equal(profile.consent, false);
});

test('loadCheckoutProfile parses all fields from preferences rows', async () => {
  const rows = [
    { key: 'checkout_profile.email', value: 'test@example.com' },
    { key: 'checkout_profile.name', value: 'Chizi M' },
    { key: 'checkout_profile.phone', value: '07700 900123' },
    { key: 'checkout_profile.address', value: JSON.stringify({ line1: '12 High St', city: 'London', postcode: 'SW1A 1AA' }) },
    { key: 'checkout_profile.consent', value: 'true' },
  ];
  const supabase = makeStubSupabase(rows);
  const profile = await loadCheckoutProfile(supabase, 'user1');
  assert.equal(profile.email, 'test@example.com');
  assert.equal(profile.name, 'Chizi M');
  assert.equal(profile.phone, '07700 900123');
  assert.equal(profile.address.line1, '12 High St');
  assert.equal(profile.consent, true);
});

test('loadCheckoutProfile treats legacy email_consent row as consent', async () => {
  const rows = [
    { key: 'checkout_profile.email', value: 'test@example.com' },
    { key: 'checkout_profile.email_consent', value: 'true' },
  ];
  const supabase = makeStubSupabase(rows);
  const profile = await loadCheckoutProfile(supabase, 'user1');
  assert.equal(profile.consent, true);
});

test('saveCheckoutProfile upserts provided fields and consent', async () => {
  const supabase = makeStubSupabase([]);
  await saveCheckoutProfile(supabase, 'user1', { name: 'Chizi M', phone: '07700 900123' }, true);
  const keys = supabase._upserted.map((u) => u.key);
  assert.ok(keys.includes('checkout_profile.name'), 'name upserted');
  assert.ok(keys.includes('checkout_profile.phone'), 'phone upserted');
  assert.ok(keys.includes('checkout_profile.consent'), 'consent upserted');
});

test('saveCheckoutEmail thin wrapper still works', async () => {
  const supabase = makeStubSupabase([]);
  const ok = await saveCheckoutEmail(supabase, 'user1', 'test@example.com', true);
  assert.equal(ok, true);
  const keys = supabase._upserted.map((u) => u.key);
  assert.ok(keys.includes('checkout_profile.email'));
});
