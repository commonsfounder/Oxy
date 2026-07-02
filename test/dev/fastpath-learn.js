// Proves the learn→reuse cycle in ONE process (the E2E harness stubs Supabase, so learned
// rows don't survive across processes; in prod they persist in browser_fastpaths).
const fs = require('fs');
process.chdir(require('path').join(__dirname, '..', '..'));
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const runtime = require('../../runtime');
const chainable = new Proxy(function () {}, { get: (_t, p) => {
  if (p === 'then') return undefined;
  if (p === 'maybeSingle' || p === 'single') return async () => ({ data: null });
  if (['upsert', 'insert', 'update', 'select', 'eq', 'order', 'limit'].includes(p)) return () => chainable;
  return () => chainable;
}, apply: () => chainable });
runtime.createSupabaseServiceClient = () => chainable;

const { runOrderingTurn, closeSession, _fastpathStore } = require('../../api/services/browser-task');
const HOST = process.argv[2] || 'https://www.next.co.uk';
const GOAL = process.argv[3] || 'find a wool coat and tell me the exact price shown';

(async () => {
  console.log('--- run 1 (should learn) ---');
  await runOrderingTurn('learn-user-1', { url: HOST, goal: GOAL, onProgress: (l) => process.stdout.write(`  ${l}\n`) });
  await closeSession('learn-user-1').catch(() => {});
  const host = new URL(HOST).hostname.replace(/^www\./, '');
  console.log('learned entry for', host, ':', _fastpathStore._map.get(host) || '(none)');
  console.log('--- done ---');
  process.exit(0);
})();
