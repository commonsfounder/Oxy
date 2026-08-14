// Append-only trace of ordering-loop steps and terminal outcomes, keyed by (user_id, site).
// Two things live here: per-step recipe-hit/vision-fallback events (for a recipe hit-rate
// report) and one terminal event per turn (for a session trace). Best-effort throughout —
// a logging failure must never affect the ordering loop, so every write swallows its own error.
'use strict';

const { createSupabaseServiceClient } = require('../../runtime');

let supabaseClient = null;
function getSupabase() {
  if (!supabaseClient) supabaseClient = createSupabaseServiceClient();
  return supabaseClient;
}

const STEP_EVENT_TYPES = ['recipe_hit', 'vision_step'];
const TERMINAL_EVENT_TYPES = ['session_done', 'session_error', 'session_ask'];

// Fire-and-forget: callers should not await this on the hot path.
// A logging failure must never affect the ordering loop, so this swallows its own error —
// but it surfaces the FIRST failure once to the logs. Silent-forever swallowing is how the
// table sat at zero rows without anyone noticing whether inserts were broken or just never
// reached; one breadcrumb tells the difference without spamming a per-step loop.
let loggedInsertFailure = false;
async function logEvent({ userId, site, eventType, stepName = null, phase = null, detail = null }) {
  try {
    const { error } = await getSupabase().from('browser_session_events').insert({
      user_id: userId,
      site: site || 'unknown',
      event_type: eventType,
      step_name: stepName,
      phase,
      detail,
    });
    if (error) throw error;
  } catch (err) {
    if (!loggedInsertFailure) {
      loggedInsertFailure = true;
      console.warn('[session-events] insert failed (further failures suppressed):', err?.message || err);
    }
  }
}

function logRecipeHit({ userId, site, stepName, phase = null }) {
  return logEvent({ userId, site, eventType: 'recipe_hit', stepName, phase });
}

function logVisionStep({ userId, site, phase = null, detail = null }) {
  return logEvent({ userId, site, eventType: 'vision_step', phase, detail });
}

function logSessionOutcome({ userId, site, outcome, steps = null, durationMs = null }) {
  const eventType = outcome === 'done' ? 'session_done' : outcome === 'ask' ? 'session_ask' : 'session_error';
  return logEvent({ userId, site, eventType, detail: { steps, durationMs } });
}

// Entity-recall isn't a browser session, but this table's (event_type, detail jsonb) shape
// already fits it and this is best-effort telemetry same as everything else here — no reason
// for a second table. 'chat' marks these as coming from the chat-routing layer, not a
// specific retailer site. routedDirectly is a proxy, not a guarantee: it says the reference
// was resolved AND the turn matched a deterministic action (no model reasoning/clarification
// needed) — not that the action itself later succeeded.
function logEntityReference({ userId, kind, resolved, routedDirectly }) {
  return logEvent({ userId, site: 'chat', eventType: 'entity_reference', detail: { kind, resolved, routedDirectly } });
}

// Pure so it's unit-testable without a live Supabase client (this module's DB-backed
// reporting functions use their own lazy singleton, same as getRecipeHitRate below, so a
// fake client can't be injected — this is the part worth pinning with a real test).
function aggregateEntityReferenceStats(rows = []) {
  const total = rows.length;
  const bare = rows.filter((r) => r.detail?.kind === 'bare').length;
  const resolved = rows.filter((r) => r.detail?.resolved).length;
  const routedDirectly = rows.filter((r) => r.detail?.resolved && r.detail?.routedDirectly).length;
  return {
    total,
    bare,
    named: total - bare,
    resolved,
    resolvedRate: total ? resolved / total : 0,
    routedDirectly,
    routedDirectlyRateOfResolved: resolved ? routedDirectly / resolved : 0
  };
}

// how often bare references occur (kind: 'bare' vs 'named'), how often they resolve, and how
// often a resolved reference was clear enough to route directly vs falling through to the
// model — the three questions this instrumentation exists to answer.
async function getEntityReferenceStats({ sinceHours = 24 * 7 } = {}) {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from('browser_session_events')
    .select('detail')
    .eq('event_type', 'entity_reference')
    .gte('created_at', since);
  if (error || !data) return null;
  return aggregateEntityReferenceStats(data);
}

// Reporting: hit rate per (site, step) over a lookback window, worst-first so the
// steps most in need of attention float to the top.
async function getRecipeHitRate({ site = null, sinceHours = 24 } = {}) {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  let query = getSupabase()
    .from('browser_session_events')
    .select('site, step_name, event_type')
    .in('event_type', STEP_EVENT_TYPES)
    .gte('created_at', since);
  if (site) query = query.eq('site', site);
  const { data, error } = await query;
  if (error || !data) return [];

  const grouped = new Map();
  for (const row of data) {
    const key = `${row.site}:${row.step_name || 'vision'}`;
    const g = grouped.get(key) || { site: row.site, step: row.step_name || 'vision', hits: 0, misses: 0 };
    if (row.event_type === 'recipe_hit') g.hits += 1; else g.misses += 1;
    grouped.set(key, g);
  }
  return [...grouped.values()]
    .map((g) => ({ ...g, total: g.hits + g.misses, hitRate: g.hits / (g.hits + g.misses) }))
    .sort((a, b) => a.hitRate - b.hitRate);
}

// Reporting: recent terminal outcomes per site, for a quick session-trace summary.
async function getSessionOutcomes({ site = null, sinceHours = 24 } = {}) {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  let query = getSupabase()
    .from('browser_session_events')
    .select('user_id, site, event_type, detail, created_at')
    .in('event_type', TERMINAL_EVENT_TYPES)
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (site) query = query.eq('site', site);
  const { data, error } = await query;
  return error || !data ? [] : data;
}

module.exports = {
  logEvent,
  logRecipeHit,
  logVisionStep,
  logSessionOutcome,
  logEntityReference,
  getRecipeHitRate,
  getSessionOutcomes,
  getEntityReferenceStats,
  aggregateEntityReferenceStats,
};
