'use strict';
// Shared auto-reply harness for the reliability benchmarks (local in-process and prod HTTP).
//
// A live user would just answer "what's your address?" — withholding it would measure the
// harness, not the loop. So the benchmarks answer the asks a real user would, and leave
// everything else alone: a genuinely unexpected ask (e.g. the payment-button-not-found
// fallback) is a real loop failure we want to see on the scorecard, not paper over.
//
// Lives in its own module so the local and prod benchmarks can't drift apart — if they
// answer asks differently, their pass rates aren't comparable and the whole point of
// running both is lost.

const DELIVERY_ASK_PAT = /delivered to your address|collected from a nearby|delivery or collection/i;
const USER_DATA_ASK_PAT = /\b(e-?mail|delivery address|shipping address|postcode|post code|zip code|phone number|mobile number|card (?:number|details)|payment details|(?:full |your )?name|sign in|log ?in|create an account)\b/i;

const BENCH_EMAIL = process.env.OXY_BENCH_CHECKOUT_EMAIL || process.env.OXY_E2E_CHECKOUT_EMAIL || 'guest@oxy-test.example';
const BENCH_NAME = process.env.OXY_BENCH_CHECKOUT_NAME || 'John Doe';
const BENCH_PHONE = process.env.OXY_BENCH_CHECKOUT_PHONE || '07700900123';
const BENCH_ADDRESS = process.env.OXY_BENCH_CHECKOUT_ADDRESS || '12 High Street, London, SW1A 1AA';

function autoReplyForAsk(c, question) {
  const q = String(question || '');
  if (DELIVERY_ASK_PAT.test(q)) return 'deliver it to my address, save my details';
  if (c.expect === 'cart' && USER_DATA_ASK_PAT.test(q)) {
    return `${BENCH_NAME}, ${BENCH_ADDRESS}, ${BENCH_PHONE}, ${BENCH_EMAIL}, save my details`;
  }
  return null;
}

module.exports = {
  autoReplyForAsk,
  DELIVERY_ASK_PAT,
  USER_DATA_ASK_PAT,
  BENCH_EMAIL,
  BENCH_NAME,
  BENCH_PHONE,
  BENCH_ADDRESS,
};
