// For test files that read and write the real Supabase project. When that database can't be
// reached (CI without secrets, an offline laptop, a sandboxed agent), each test is reported as
// skipped with the reason, instead of failing in a way that buries real regressions among dozens
// of connection errors. Set OXY_REQUIRE_REAL_DB=1 to make an unreachable database a failure.

const nodeTest = require('node:test');

let reachable = null;

function realDatabaseReachable() {
  if (reachable) return reachable;
  reachable = (async () => {
    const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_KEY || '';
    if (!url || !key) return { ok: false, reason: 'SUPABASE_URL and SUPABASE_KEY are not set' };
    try {
      const response = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(4000)
      });
      return response.ok
        ? { ok: true }
        : { ok: false, reason: `${url} answered HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, reason: `${url} is unreachable (${error.cause?.code || error.cause?.errors?.[0]?.code || error.cause?.message || error.message})` };
    }
  })();
  return reachable;
}

async function unavailableReason() {
  const state = await realDatabaseReachable();
  if (state.ok) return null;
  if (process.env.OXY_REQUIRE_REAL_DB === '1') throw new Error(`Real database required but ${state.reason}.`);
  return state.reason;
}

function test(name, options, fn) {
  if (typeof options === 'function') [options, fn] = [{}, options];
  return nodeTest(name, options, async t => {
    const reason = await unavailableReason();
    if (reason) return t.skip(`real database: ${reason}`);
    return fn(t);
  });
}

for (const hook of ['before', 'after', 'beforeEach', 'afterEach']) {
  test[hook] = fn => nodeTest[hook](async (...args) => {
    if (await unavailableReason()) return undefined;
    return fn(...args);
  });
}

module.exports = test;
module.exports.realDatabaseReachable = realDatabaseReachable;
