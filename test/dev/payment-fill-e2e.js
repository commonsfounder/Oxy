// Live-browser verification of the payment-fill machinery (no network, no real money):
// serves a fake checkout locally — masked card-number input inside a cross-frame iframe
// (PSP hosted-field shape), combined MM/YY input, CVC, cardholder name, expiry-month
// <select>, billing postcode — then drives the REAL browser-task fill/click/classify
// code against it and asserts the whole arc: fields detected → filled → Pay clicked →
// confirmation page classified as 'confirmed'.
//
// Run: node test/dev/payment-fill-e2e.js

const http = require('http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-extra');
const {
  fillPaymentCard,
  paymentCardFieldsPresent,
  classifyPaymentOutcome,
  findAndClickPayButton
} = require('../../api/services/browser-task');

const CARD_FRAME_HTML = `<!doctype html><html><body>
  <label for="cardnumber">Card number</label>
  <input id="cardnumber" name="cardnumber" autocomplete="cc-number" inputmode="numeric" placeholder="1234 1234 1234 1234">
  <script>
    // Mimic PSP masking: reformat with spaces on every input event.
    const el = document.getElementById('cardnumber');
    el.addEventListener('input', () => {
      const digits = el.value.replace(/\\D/g, '').slice(0, 16);
      el.value = digits.replace(/(.{4})/g, '$1 ').trim();
    });
  </script>
</body></html>`;

function checkoutHtml(port) {
  return `<!doctype html><html><body>
  <h1>Checkout — payment</h1>
  <p>Order summary: Off-peak return, London to Manchester — £42.50. We'll send you a confirmation email.</p>
  <label for="ccname">Name on card</label><input id="ccname" name="nameOnCard">
  <iframe src="http://127.0.0.1:${port}/card-frame" title="Secure card number"></iframe>
  <label for="exp">Expiry date (MM/YY)</label><input id="exp" name="expiryDate" placeholder="MM / YY">
  <label for="expmonth">Expiry month</label>
  <select id="expmonth" name="expiry-month"><option value="">Month</option><option value="03">March</option><option value="09">September</option></select>
  <label for="cvc">Security code</label><input id="cvc" name="cvc" maxlength="4">
  <label for="zip">Billing postcode</label><input id="zip" name="billingPostcode">
  <button id="pay" onclick="finish()">Pay £42.50 now</button>
  <script>
    function finish() {
      const num = document.querySelector('iframe'); // filled state checked server-side in real life
      const name = document.getElementById('ccname').value;
      const exp = document.getElementById('exp').value;
      const cvc = document.getElementById('cvc').value;
      if (!name || !exp || !cvc) {
        document.body.insertAdjacentHTML('beforeend', '<p>Payment failed — please check your card details</p>');
        return;
      }
      document.body.innerHTML = '<h1>Thank you for your order!</h1><p>Order number: TR12345</p>';
    }
  </script>
</body></html>`;
}

async function main() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/card-frame') return res.end(CARD_FRAME_HTML);
    res.end(checkoutHtml(server.address().port));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/checkout`);

  const card = { name: 'Chizi G', number: '4242424242424242', expMonth: 3, expYear: 2028, cvc: '123' };
  const session = { page, checkoutProfile: { consent: true, address: { postcode: 'SW1A 1AA' } } };

  // 1. Empty card form is detected (via the iframe-hosted number field)
  assert.equal(await paymentCardFieldsPresent(page), true, 'card fields should be detected');
  // 2. Pre-pay page must NOT classify as confirmed despite "confirmation email" copy
  assert.equal(await classifyPaymentOutcome(page), 'unknown', 'checkout page must not read as confirmed');

  // 3. Fill everything
  const filled = await fillPaymentCard(session, card, (m) => console.log('  •', m));
  console.log(`filled ${filled} logical fields`);
  assert.ok(filled >= 4, `expected >=4 fields filled, got ${filled}`);

  // Masked iframe input got the full PAN through its reformatting listener
  const frame = page.frames().find((f) => f.url().includes('card-frame'));
  const typedNumber = await frame.evaluate(() => document.getElementById('cardnumber').value);
  assert.equal(typedNumber.replace(/\s/g, ''), card.number, 'masked card number should hold full PAN');
  assert.equal(await page.inputValue('#exp'), '03/28');
  assert.equal(await page.inputValue('#cvc'), '123');
  assert.equal(await page.inputValue('#ccname'), 'Chizi G');
  assert.equal(await page.inputValue('#zip'), 'SW1A 1AA');
  // Combined MM/YY and split month select are alternatives — combined won, select skipped
  assert.equal(await page.$eval('#expmonth', (el) => el.value), '', 'month select must be skipped when combined expiry was filled');
  assert.equal(await paymentCardFieldsPresent(page), false, 'no empty card fields left');

  // Scenario B: split expiry selects only (no combined field) — the select path
  const pageB = await browser.newPage();
  await pageB.setContent(`<!doctype html><html><body>
    <label for="num">Card number</label><input id="num" name="cardNumber">
    <select id="m" name="expiry-month"><option value="">MM</option><option value="3">3</option><option value="9">9</option></select>
    <select id="y" name="expiry-year"><option value="">YY</option><option value="27">27</option><option value="28">28</option></select>
    <input id="cvc2" name="securityCode">
  </body></html>`);
  const filledB = await fillPaymentCard({ page: pageB, checkoutProfile: null }, card, () => {});
  assert.ok(filledB >= 4, `scenario B expected >=4 fields, got ${filledB}`);
  assert.equal(await pageB.$eval('#m', (el) => el.value), '3', 'unpadded month option should be chosen');
  assert.equal(await pageB.$eval('#y', (el) => el.value), '28', '2-digit year option should be chosen');
  assert.equal(await pageB.inputValue('#num'), card.number);
  await pageB.close();

  // 4. Click pay via the exact-label path and classify the confirmation
  const clicked = await findAndClickPayButton(page, 'Pay £42.50 now');
  assert.equal(clicked, 'Pay £42.50 now');
  await page.waitForTimeout(300);
  assert.equal(await classifyPaymentOutcome(page), 'confirmed');

  await browser.close();
  server.close();
  console.log('PASS — detect → fill (iframe/masked/select) → pay → confirmed, all through real browser-task code');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
