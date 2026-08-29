'use strict';
// Minimal post-deploy smoke test. Run this right after a deploy to answer one question:
// did the thing that was supposed to go live actually go live, cleanly, against real
// providers? Not a test suite — eight sequential real checks, each pass/fail, no framework.
//
// Usage:
//   node test/dev/release-smoke-test.js                         # against BASE_URL or localhost
//   BASE_URL=https://milgrain-live-2026.fly.dev node test/dev/release-smoke-test.js
//
// Reads secrets from .env (present locally) or the real process environment (Fly.io) —
// never written to disk, never printed.

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Steps 3+ call api.executeAction IN THIS PROCESS, not over HTTP — so they need the SAME
// Steps 3+ need the same credentials as the deployed service. Fly secrets are not
// pulled into a local process; provide them explicitly in the environment when running
// provider-backed checks.

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const USER = process.env.SMOKE_USER || 'user123';
const TAG = 'ADAM-RELEASE-SMOKE';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const axios = require(path.join(__dirname, '..', '..', 'node_modules', 'axios'));
  const { createSessionToken } = require('../../auth');
  const api = require('../../api/index.js');

  // 1. /health
  try {
    const res = await axios.get(`${BASE_URL}/health`, { timeout: 10000 });
    const body = res.data;
    const ok = res.status === 200 && body.status === 'ok' && body.db.status === 'ok';
    record('1. /health', ok, `status=${body.status} db=${body.db.status} missingEnv=${body.missingEnv.length}`);
  } catch (e) {
    record('1. /health', false, e.message);
  }

  // 2. An authenticated request routes and responds — /action-contracts is a real
  // requireSessionAuth-gated endpoint with no side effects, proof of the real auth path
  // without spending on a full LLM turn.
  try {
    const token = createSessionToken(USER);
    const res = await axios.get(`${BASE_URL}/action-contracts`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 10000, validateStatus: () => true
    });
    record('2. authenticated request', res.status === 200, `status=${res.status}`);
  } catch (e) {
    record('2. authenticated request', false, e.message);
  }

  // 3. Real Gmail read
  try {
    const r = await api.executeAction(USER, 'search_emails', { query: 'in:inbox', max_results: 1 });
    record('3. read Gmail', r.success === true, r.success ? `${(r.emails || []).length} result(s)` : r.error);
  } catch (e) {
    record('3. read Gmail', false, e.message);
  }

  // 4. Real Calendar read
  try {
    const r = await api.executeAction(USER, 'get_calendar_events', { max_results: 3 });
    record('4. read Calendar', r.success === true, r.success ? `${(r.events || []).length} event(s)` : r.error);
  } catch (e) {
    record('4. read Calendar', false, e.message);
  }

  // 5. Create + clean up one safe test calendar event, through the real cancel path.
  try {
    const created = await api.executeAction(USER, 'schedule_block', {
      title: `${TAG} - calendar`, duration_minutes: 15, earliest: '10:00', latest: '20:00', days: 3
    });
    if (!created.success) throw new Error(created.error || 'create failed');
    const cancelled = await api.executeAction(USER, 'cancel_calendar_event', { title: `${TAG} - calendar` });
    record('5. create + clean up test calendar object', cancelled.success === true, `event ${created.eventId}`);
  } catch (e) {
    record('5. create + clean up test calendar object', false, e.message);
  }

  // 6. A real notification through the real runtime, immediately suppressed so it never
  // actually pages anyone — this proves raise -> route -> provider selection works without
  // spamming a real channel on every deploy.
  try {
    const raised = await api.notificationDelivery.raise(USER, {
      category: 'other', urgency: 'low',
      title: `[${TAG}] deploy smoke test`,
      body: 'Created and immediately suppressed by the release smoke test — not a real notification.',
      dedupeKey: `other|task:release-smoke|run:${Date.now()}`,
      sourceRef: { scheduledTaskId: 'release-smoke' }
    });
    const { createClient } = require(path.join(__dirname, '..', '..', 'node_modules', '@supabase', 'supabase-js'));
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    await supabase.from('notification_events')
      .update({ status: 'suppressed', last_error: 'release smoke test — never meant to deliver' })
      .eq('id', raised.id);
    record('6. notification runtime raise+route', Boolean(raised.ok), `id=${raised.id}`);
  } catch (e) {
    record('6. notification runtime raise+route', false, e.message);
  }

  // 7. The scheduler can read its own queue.
  try {
    const { createClient } = require(path.join(__dirname, '..', '..', 'node_modules', '@supabase', 'supabase-js'));
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data, error } = await supabase.from('scheduled_tasks').select('id').eq('user_id', USER).limit(1);
    if (error) throw error;
    record('7. scheduler reads its queue', true, `${data.length} row(s) visible`);
  } catch (e) {
    record('7. scheduler reads its queue', false, e.message);
  }

  // 8. Supabase/RLS error state — service_role must read; anon must be blocked (the
  // documented, deliberate posture: RLS enabled, zero policies, service_role bypasses).
  try {
    const { createClient } = require(path.join(__dirname, '..', '..', 'node_modules', '@supabase', 'supabase-js'));
    const service = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const serviceRead = await service.from('users').select('user_id').limit(1);
    let anonBlocked = true;
    if (process.env.SUPABASE_ANON_KEY) {
      const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
      const anonRead = await anon.from('users').select('user_id').limit(1);
      anonBlocked = Boolean(anonRead.error) || (anonRead.data || []).length === 0;
    }
    record('8. Supabase/RLS posture', !serviceRead.error && anonBlocked,
      process.env.SUPABASE_ANON_KEY ? 'service_role reads, anon blocked' : 'service_role reads (no anon key set to check the other side)');
  } catch (e) {
    record('8. Supabase/RLS posture', false, e.message);
  }

  console.log('\n--- summary ---');
  const failed = results.filter(r => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('failed:', failed.map(f => f.name).join('; '));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
