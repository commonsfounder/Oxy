const assert = require('node:assert/strict');
const test = require('node:test');
const { looksLikeLoginWall, findGuestCheckoutElement, looksLikeBlockWall, describesBlockWall } = require('../../api/services/browser-task');

test('findGuestCheckoutElement finds a guest option among clickable elements (M&S/Wickes shapes)', () => {
  const msElements = [
    { locatorIndex: 3, text: 'Sign in' },
    { locatorIndex: 7, text: 'Guest Checkout' },
    { locatorIndex: 9, text: 'Reset your password' },
  ];
  assert.deepEqual(findGuestCheckoutElement(msElements), { locatorIndex: 7, text: 'Guest Checkout' });

  const wickesElements = [
    { locatorIndex: 1, text: 'Sign in' },
    { locatorIndex: 2, text: 'Checkout as a guest' },
  ];
  assert.deepEqual(findGuestCheckoutElement(wickesElements), { locatorIndex: 2, text: 'Checkout as a guest' });

  const otherPhrasing = [{ locatorIndex: 0, text: 'Continue without an account' }];
  assert.deepEqual(findGuestCheckoutElement(otherPhrasing), otherPhrasing[0]);
});

test('findGuestCheckoutElement returns null when no guest option is present', () => {
  assert.equal(findGuestCheckoutElement([{ locatorIndex: 0, text: 'Sign in' }, { locatorIndex: 1, text: 'Register' }]), null);
  assert.equal(findGuestCheckoutElement([]), null);
  assert.equal(findGuestCheckoutElement(null), null);
});

test('findGuestCheckoutElement does not false-match unrelated "guest" copy', () => {
  // "Guest" appearing in unrelated copy (e.g. a "guest reviews" link) must not match.
  assert.equal(findGuestCheckoutElement([{ locatorIndex: 0, text: 'Guest reviews (12)' }]), null);
});

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

test('looksLikeLoginWall fires on soft basket sign-in gate without pw field (M&S style)', () => {
  assert.equal(looksLikeLoginWall({
    url: 'https://www.marksandspencer.com/basket',
    bodyText: 'Sign in or create an account for faster checkout and to view your basket',
    hasPasswordField: false,
    goal: 'order t-shirt'
  }), true);
  assert.equal(looksLikeLoginWall({
    url: 'https://shop.example.com/checkout',
    bodyText: 'Please sign in to continue to checkout',
    hasPasswordField: false,
    goal: 'buy it'
  }), true);
});

test('looksLikeLoginWall tolerates missing/garbage input', () => {
  assert.equal(looksLikeLoginWall({}), false);
  assert.equal(looksLikeLoginWall({ url: null, bodyText: null, hasPasswordField: null, goal: null }), false);
});

test('looksLikeBlockWall fires on anti-automation interstitials (small page + copy)', () => {
  // The shapes the benchmark actually hit: Next & Argos returned "Access Denied" after search.
  assert.equal(looksLikeBlockWall({ text: 'Access Denied\nYou don\'t have permission to access this resource.', bodyLen: 70 }), true);
  assert.equal(looksLikeBlockWall({ text: 'Checking your browser before accessing the site.', bodyLen: 60 }), true);
  assert.equal(looksLikeBlockWall({ text: 'Please verify you are a human to continue.', bodyLen: 45 }), true);
  assert.equal(looksLikeBlockWall({ text: 'Pardon our interruption... Press & Hold to confirm you are a human', bodyLen: 90 }), true);
});

test('looksLikeBlockWall fires on Nike\'s add-to-cart automation rejection dialog', () => {
  // Nike serves the PDP fine but refuses the add-to-cart API behind a dialog: "We Couldn't
  // Complete Your Request … disable any browser extensions … and reopen Nike.com." The
  // dialog text is probed separately (page behind it keeps bodyLen large).
  assert.equal(looksLikeBlockWall({
    text: 'We Couldn\'t Complete Your Request\nClose this tab, disable any browser extensions (such as coupon or promo code tools) and reopen Nike.com.\nView Bag',
    bodyLen: 150,
  }), true);
});

test('looksLikeBlockWall does NOT fire on a normal shopping page that merely mentions the words', () => {
  // A full 5k-char product page is not a wall even if a footer link says "captcha" or a help
  // article mentions "unusual traffic" — the length gate protects against that.
  assert.equal(looksLikeBlockWall({ text: 'Wool Jumper £45.00 Add to bag ... recaptcha challenge protected form', bodyLen: 5200 }), false);
  // A real results page with the term present, no wall copy.
  assert.equal(looksLikeBlockWall({ text: 'Kettle 1.7L £24.99 In stock Add to trolley', bodyLen: 3000 }), false);
});

test('looksLikeBlockWall tolerates missing/garbage input', () => {
  assert.equal(looksLikeBlockWall({}), false);
  assert.equal(looksLikeBlockWall({ text: null, bodyLen: null }), false);
  assert.equal(looksLikeBlockWall(), false);
  // Copy present but no length info → still fires (unknown length is not > 1500).
  assert.equal(looksLikeBlockWall({ text: 'Access Denied' }), true);
});

test('describesBlockWall catches a model ask about a bot/security wall (Cloudflare iframe case)', () => {
  // The exact shape the benchmark hit on Just Eat: model saw a Cloudflare screen (in an
  // iframe the text-probe can't read) and tried to ask the user.
  assert.equal(describesBlockWall("I've encountered a security verification screen (Cloudflare) on Just Eat. Would you like me to try another site?"), true);
  assert.equal(describesBlockWall('There is a captcha I need you to solve.'), true);
  assert.equal(describesBlockWall('The page says Access Denied — what should I do?'), true);
  assert.equal(describesBlockWall('Please verify you are a human to continue.'), true);
});

test('describesBlockWall does NOT fire on a legitimate order question', () => {
  assert.equal(describesBlockWall('Which pizza would you like to order?'), false);
  assert.equal(describesBlockWall('What size would you like?'), false);
  assert.equal(describesBlockWall('I found two branches — which one?'), false);
  assert.equal(describesBlockWall(''), false);
  assert.equal(describesBlockWall(null), false);
});
