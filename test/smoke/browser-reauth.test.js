const assert = require('node:assert/strict');
const test = require('node:test');
const { looksLikeLoginWall } = require('../../api/services/browser-task');

test('looksLikeLoginWall fires on a login URL', () => {
  assert.equal(looksLikeLoginWall({ url: 'https://www.johnlewis.com/account/login', bodyText: '', hasPasswordField: false, goal: 'order joggers' }), true);
  assert.equal(looksLikeLoginWall({ url: 'https://www.ubereats.com/signin', bodyText: '', hasPasswordField: false, goal: 'order pizza' }), true);
  assert.equal(looksLikeLoginWall({ url: 'https://x.com/auth/sign-in?next=/cart', bodyText: '', hasPasswordField: false, goal: 'buy it' }), true);
});

test('looksLikeLoginWall fires on a password field + sign-in copy', () => {
  assert.equal(looksLikeLoginWall({
    url: 'https://shop.example.com/checkout',
    bodyText: 'Sign in to continue\nEmail\nPassword\nForgot your password?',
    hasPasswordField: true,
    goal: 'order a coat'
  }), true);
});

test('looksLikeLoginWall does NOT fire on a normal shopping page', () => {
  // A password field alone (e.g. an inline "create account" upsell) without login copy is not a wall.
  assert.equal(looksLikeLoginWall({
    url: 'https://www.johnlewis.com/search?search-term=joggers',
    bodyText: 'adidas Essential Three Stripes Fleece Jogging Trousers £27.00 Add to basket',
    hasPasswordField: false,
    goal: 'order joggers'
  }), false);
  // Login copy but no password field and no login URL — a "Sign in" header link on a normal page.
  assert.equal(looksLikeLoginWall({
    url: 'https://www.johnlewis.com/',
    bodyText: 'Sign in / Register  Baskets  Menswear  Womenswear',
    hasPasswordField: false,
    goal: 'order joggers'
  }), false);
});

test('looksLikeLoginWall tolerates missing/garbage input', () => {
  assert.equal(looksLikeLoginWall({}), false);
  assert.equal(looksLikeLoginWall({ url: null, bodyText: null, hasPasswordField: null, goal: null }), false);
});
