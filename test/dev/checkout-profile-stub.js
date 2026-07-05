'use strict';
// Shared Supabase stub so benchmarks/E2E can auto-fill checkout and reach ready_for_payment.

function createCheckoutProfileSupabase() {
  const email = process.env.OXY_E2E_CHECKOUT_EMAIL || process.env.OXY_BENCH_CHECKOUT_EMAIL || '';
  const consent = process.env.OXY_E2E_CHECKOUT_CONSENT !== 'false' && process.env.OXY_BENCH_CHECKOUT_CONSENT !== 'false';
  const name = process.env.OXY_E2E_CHECKOUT_NAME || process.env.OXY_BENCH_CHECKOUT_NAME || 'Test User';
  const phone = process.env.OXY_E2E_CHECKOUT_PHONE || process.env.OXY_BENCH_CHECKOUT_PHONE || '07700900123';
  const addressRaw = process.env.OXY_E2E_CHECKOUT_ADDRESS || process.env.OXY_BENCH_CHECKOUT_ADDRESS || '12 High Street, London, SW1A 1AA';

  const ctx = { table: null, op: null };
  const resolve = async () => {
    if (ctx.table === 'preferences' && ctx.op === 'select' && email) {
      const addrParts = addressRaw.split(',').map((s) => s.trim());
      const address = {
        line1: addrParts[0] || addressRaw,
        city: addrParts.length > 2 ? addrParts[addrParts.length - 2] : 'London',
        postcode: addrParts[addrParts.length - 1] || 'SW1A 1AA',
      };
      return {
        data: [
          { key: 'checkout_profile.email', value: email },
          { key: 'checkout_profile.name', value: name },
          { key: 'checkout_profile.phone', value: phone },
          { key: 'checkout_profile.address', value: JSON.stringify(address) },
          ...(consent ? [
            { key: 'checkout_profile.email_consent', value: 'true' },
            { key: 'checkout_profile.consent', value: 'true' },
          ] : []),
        ],
        error: null,
      };
    }
    return { data: null, error: null };
  };

  const builder = {
    from(t) { ctx.table = t; return builder; },
    select() { ctx.op = 'select'; return builder; },
    eq() { return builder; },
    in() { return builder; },
    like() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    delete: async () => ({ data: null, error: null }),
    maybeSingle: resolve,
    single: resolve,
    upsert: async () => ({ data: null, error: null }),
    insert: async () => ({ data: null, error: null }),
    update: async () => ({ data: null, error: null }),
    then(onFulfilled, onRejected) { return resolve().then(onFulfilled, onRejected); },
  };
  return builder;
}

module.exports = { createCheckoutProfileSupabase };