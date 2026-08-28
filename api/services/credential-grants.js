'use strict';

// Bounded permission to use a stored site password, plus the record of every use — the answer to
// "when may it sign in without asking me first?". A tap per sign-in makes unattended work
// impossible, and no gate at all leaves the model's own choice of site as the only lock on a
// password, on an agent that reads pages written by strangers.
//
// So the grant is the authority and only the user creates one: the model can narrow a set of
// sites, never widen it. Grants expire, can be revoked instantly, and can carry a use cap. The
// decision is pure, so every refusal path is testable without a database.

const { normalizeSite } = require('./vault-credentials');

const GRANT_SCOPES = Object.freeze(['task', 'standing']);
const USE_OUTCOMES = Object.freeze(['used', 'denied', 'failed']);
const DEFAULT_TASK_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 60 * 24 * 30; // a grant that never expires is not a grant

/**
 * Decide whether a stored credential may be used right now. Takes the grant rather than fetching
 * it, so every refusal reason is testable directly.
 *
 * @returns {{allowed: boolean, reason: string}}
 */
function decideCredentialUse({ grant, site, requestedSites = null, taskId = null, now = new Date() } = {}) {
  if (!grant) return { allowed: false, reason: 'no_grant' };

  // Provenance first. A grant row that did not come from a deliberate user action must not
  // authorise anything, whatever else it says.
  if ((grant.granted_via || 'user') !== 'user') return { allowed: false, reason: 'not_user_granted' };

  // Revocation is the emergency stop, so it outranks an unexpired window.
  if (grant.revoked_at) return { allowed: false, reason: 'revoked' };

  const target = normalizeSite(site);
  if (!target) return { allowed: false, reason: 'site_not_granted' };
  if (normalizeSite(grant.site) !== target) return { allowed: false, reason: 'site_not_granted' };

  // The model may narrow the grant to the sites this task actually needs. It can never
  // widen it: a site with no grant of its own was already refused above.
  if (Array.isArray(requestedSites)) {
    const requested = requestedSites.map(normalizeSite).filter(Boolean);
    if (!requested.includes(target)) return { allowed: false, reason: 'site_not_requested' };
  }

  if (grant.scope === 'task') {
    // A task grant with no task in hand is not a free pass.
    if (!taskId || grant.task_id !== taskId) return { allowed: false, reason: 'wrong_task' };
  }

  const expiresAt = grant.expires_at ? new Date(grant.expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) return { allowed: false, reason: 'expired' };
  if (expiresAt.getTime() <= new Date(now).getTime()) return { allowed: false, reason: 'expired' };

  // A null cap means uncapped; it must not read as zero.
  if (grant.max_uses !== null && grant.max_uses !== undefined) {
    if (Number(grant.use_count || 0) >= Number(grant.max_uses)) {
      return { allowed: false, reason: 'use_limit_reached' };
    }
  }

  return { allowed: true, reason: 'granted' };
}

function validateGrantInput({ site, scope = 'task', taskId = null, ttlMinutes, maxUses = null } = {}) {
  const normalizedSite = normalizeSite(site);
  if (!normalizedSite) return { ok: false, error: 'A site is required.' };
  if (!GRANT_SCOPES.includes(scope)) return { ok: false, error: `Scope must be one of: ${GRANT_SCOPES.join(', ')}.` };
  if (scope === 'task' && !taskId) return { ok: false, error: 'A task-scoped grant needs the task it belongs to.' };

  const ttl = Number(ttlMinutes ?? DEFAULT_TASK_TTL_MINUTES);
  if (!Number.isFinite(ttl) || ttl <= 0) return { ok: false, error: 'A grant needs a positive lifetime.' };
  if (ttl > MAX_TTL_MINUTES) return { ok: false, error: 'A grant cannot last longer than 30 days.' };

  if (maxUses !== null && maxUses !== undefined) {
    const cap = Number(maxUses);
    if (!Number.isInteger(cap) || cap <= 0) return { ok: false, error: 'A use limit must be a positive whole number.' };
  }

  return {
    ok: true,
    grant: {
      site: normalizedSite,
      scope,
      taskId: scope === 'task' ? taskId : null,
      ttlMinutes: ttl,
      maxUses: maxUses === null || maxUses === undefined ? null : Number(maxUses)
    }
  };
}

async function createGrant(supabase, userId, input) {
  const result = validateGrantInput(input);
  if (!result.ok) return result;
  const { site, scope, taskId, ttlMinutes, maxUses } = result.grant;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

  const { data, error } = await supabase
    .from('credential_grants')
    .insert({
      user_id: userId,
      site,
      scope,
      task_id: taskId,
      expires_at: expiresAt,
      max_uses: maxUses,
      granted_via: 'user'
    })
    .select('id, site, scope, task_id, expires_at, max_uses, use_count, created_at, revoked_at')
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, grant: data };
}

/** Recent grants for a site, newest first, including revoked and expired ones — filtering them
 *  in SQL would make a revoked grant indistinguishable from never having had one, and log
 *  'no_grant' for a deliberate revocation. The caller picks the first grant that authorises. */
async function findGrantsForSite(supabase, userId, site, limit = 5) {
  const normalizedSite = normalizeSite(site);
  if (!normalizedSite) return [];
  const { data } = await supabase
    .from('credential_grants')
    .select('id, site, scope, task_id, expires_at, max_uses, use_count, revoked_at, granted_via')
    .eq('user_id', userId)
    .eq('site', normalizedSite)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

/** The first grant for a site that currently authorises, or null. */
async function findGrantForSite(supabase, userId, site) {
  const grants = await findGrantsForSite(supabase, userId, site);
  return grants.find(grant => decideCredentialUse({ grant, site }).allowed) || null;
}

async function listGrants(supabase, userId) {
  const { data, error } = await supabase
    .from('credential_grants')
    .select('id, site, scope, task_id, expires_at, max_uses, use_count, created_at, revoked_at, granted_via')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) return { grants: [], error: error.message };
  return { grants: data || [] };
}

async function revokeGrant(supabase, userId, grantId) {
  const { data, error } = await supabase
    .from('credential_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', grantId)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'That permission does not exist or was already revoked.' };
  return { ok: true };
}

/** Every attempt is recorded, allowed or not. A refusal is the more interesting record:
 *  it is what shows a page trying to steer the agent at a site you never granted. */
async function recordUse(supabase, userId, { site, grantId = null, taskId = null, outcome, reason = null } = {}) {
  if (!USE_OUTCOMES.includes(outcome)) throw new Error(`Unknown credential use outcome: ${outcome}`);
  const { error } = await supabase
    .from('credential_use_log')
    .insert({
      user_id: userId,
      site: normalizeSite(site),
      grant_id: grantId,
      task_id: taskId,
      outcome,
      reason
    });
  return { ok: !error, error: error?.message || null };
}

async function listUses(supabase, userId, limit = 100) {
  const { data, error } = await supabase
    .from('credential_use_log')
    .select('id, site, grant_id, task_id, outcome, reason, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(Number(limit) || 100, 500)));
  if (error) return { uses: [], error: error.message };
  return { uses: data || [] };
}

/**
 * Claim ONE use of a grant, atomically. The increment is a compare-and-set on the use_count just
 * read, not a blind read+1: two runs signing in at once both read 0 and both write 1, so a grant
 * capped at one use pays for two sign-ins.
 *
 * @returns {{ok: true} | {ok: false, raced: true} | {ok: false, error: unknown}}
 */
async function claimGrantUse(supabase, userId, grant) {
  const current = Number(grant.use_count || 0);
  try {
    const { data, error } = await supabase
      .from('credential_grants')
      .update({ use_count: current + 1 })
      .eq('id', grant.id)
      .eq('user_id', userId)
      .eq('use_count', current)
      .select('id')
      .maybeSingle();
    // supabase-js resolves with `{ error }` rather than rejecting — even a dead network arrives
    // as a value — so a try/catch alone hands out the cap uncounted. The catch stays for mocks.
    if (error) return { ok: false, error };
    // No row matched: the count moved under us. Not an error -- a lost race, which the
    // caller retries against the fresh count rather than refusing outright.
    if (!data) return { ok: false, raced: true };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// Enough attempts to survive genuine contention, few enough that a permanently stuck
// counter fails fast instead of spinning.
const MAX_CLAIM_ATTEMPTS = 3;

/**
 * The one call the browser loop should use: look up the grant, decide, record the outcome,
 * and count the use. Recording happens on both paths so the log is a complete history
 * rather than only a record of successes.
 */
async function authorizeCredentialUse(supabase, userId, { site, requestedSites = null, taskId = null, now = new Date() } = {}) {
  let lastGrants = [];
  let decision = { allowed: false, reason: 'no_grant' };
  let grant = null;

  // Re-read on every attempt. A lost race means some other run just consumed a use, so the
  // cap has to be re-checked against the NEW count -- retrying the same stale row would be
  // the overrun this loop exists to prevent.
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const grants = await findGrantsForSite(supabase, userId, site).catch(() => []);
    lastGrants = grants;

    grant = null;
    decision = { allowed: false, reason: 'no_grant' };
    for (const candidate of grants) {
      const outcome = decideCredentialUse({ grant: candidate, site, requestedSites, taskId, now });
      if (outcome.allowed) { grant = candidate; decision = outcome; break; }
      // Keep the newest real explanation ('revoked', 'expired', 'use_limit_reached') rather
      // than reporting 'no_grant' for a permission the user did create.
      if (decision.reason === 'no_grant') decision = outcome;
    }

    if (!decision.allowed) break;

    // Count the use BEFORE handing the credential over. Over-counting a sign-in that then
    // fails is the safe direction; under-counting would let a capped grant overrun.
    const claim = await claimGrantUse(supabase, userId, grant);
    if (claim.ok) {
      await recordUse(supabase, userId, {
        site, grantId: grant.id, taskId, outcome: 'used', reason: null
      }).catch(() => {});
      return { allowed: true, reason: decision.reason, grant };
    }

    if (!claim.raced) {
      // A counter that failed to advance must not hand out an uncounted credential.
      await recordUse(supabase, userId, {
        site, grantId: grant.id, taskId, outcome: 'denied', reason: 'use_count_failed'
      }).catch(() => {});
      return { allowed: false, reason: 'use_count_failed', grant: null };
    }
    decision = { allowed: false, reason: 'use_count_raced' };
  }

  await recordUse(supabase, userId, {
    site, grantId: lastGrants[0]?.id || null, taskId, outcome: 'denied', reason: decision.reason
  }).catch(() => {});
  return { allowed: false, reason: decision.reason, grant: null };
}


module.exports = {
  DEFAULT_TASK_TTL_MINUTES,
  MAX_CLAIM_ATTEMPTS,
  GRANT_SCOPES,
  MAX_TTL_MINUTES,
  USE_OUTCOMES,
  authorizeCredentialUse,
  createGrant,
  decideCredentialUse,
  findGrantForSite,
  findGrantsForSite,
  listGrants,
  listUses,
  recordUse,
  revokeGrant,
  validateGrantInput
};
