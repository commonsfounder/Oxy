'use strict';

// General natural-language watches — a poll task, a condition and a saved last state — on the
// scheduler that already exists. Whether one fires is decided here from the observation the run
// recorded, never by asking the model to assert its condition came true: a model can hallucinate
// "[WATCH_TRIGGERED]", not a number being below a threshold once the number is written down.
// No second scheduler: cadence, claiming, advancing and expiry stay scheduled-tasks.js's job.

const WATCH_TYPES = ['state_change', 'threshold', 'recurring_check', 'context'];
const NOTIFY_RULES = ['once', 'every_change', 'ongoing'];
const MAX_HISTORY = 10;

function clean(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

// Meaningful state, not raw page text. "In Stock", "in stock." and "IN STOCK" are one state;
// a timestamp or a session id that moved is not a change at all. This is the noise control:
// without it every poll of a live page looks like a change.
function normalizeState(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}t?[\d:.]*z?\b/g, ' ')
    .replace(/[^a-z0-9£$€%. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').replace(/,/g, '');
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

function buildWatchConfig({
  type, threshold, comparator, notify_rule, source_url, condition
} = {}) {
  const resolvedType = WATCH_TYPES.includes(type) ? type : null;
  const thresholdValue = parseNumber(threshold);
  // A stated threshold implies a threshold watch even if the type was not spelled out.
  const finalType = resolvedType || (thresholdValue !== null ? 'threshold' : 'state_change');
  return {
    type: finalType,
    threshold: finalType === 'threshold' ? thresholdValue : null,
    comparator: comparator === 'above' ? 'above' : 'below',
    // A threshold watch defaults to notifying once: the user asked to be told when it drops
    // below £500, not to be told every half hour for as long as it stays there.
    notifyRule: NOTIFY_RULES.includes(notify_rule)
      ? notify_rule
      : (finalType === 'threshold' || finalType === 'context' ? 'once' : finalType === 'recurring_check' ? 'ongoing' : 'every_change'),
    sourceUrl: clean(source_url, 500) || null,
    condition: clean(condition, 300) || null,
    baseline: null,
    lastObserved: null,
    history: [],
    lastEvaluation: null
  };
}

// The deterministic verdict. Returns the NEXT watch_state as well as whether to notify, so
// the caller writes one object rather than reconstructing it.
function evaluateObservation(watchState = {}, observation = {}, now = new Date()) {
  const state = { ...buildWatchConfig(watchState), ...watchState };
  const at = (now instanceof Date ? now : new Date()).toISOString();

  // Honest degradation. A run that could not read its source has observed nothing — it must
  // never be recorded as "unchanged", because that is indistinguishable from a real reading
  // and would let a broken watch look healthy forever.
  if (observation.accessible === false) {
    const reason = clean(observation.error || 'the source could not be read', 200);
    const evaluation = { notify: true, kind: 'blocked', reason, at, terminal: false };
    return {
      notify: true,
      kind: 'blocked',
      reason,
      terminal: false,
      state: { ...state, lastEvaluation: evaluation, lastBlockedAt: at }
    };
  }

  const rawValue = observation.value;
  const numeric = parseNumber(rawValue);
  const normalized = normalizeState(observation.state ?? rawValue);
  const entry = { at, value: rawValue ?? null, state: normalized || null, note: clean(observation.note, 200) || null };
  const history = [...(state.history || []), entry].slice(-MAX_HISTORY);
  const previous = state.lastObserved || null;
  const baseline = state.baseline || entry;
  const isFirst = !previous;

  let notify = false;
  let kind = 'unchanged';
  let reason = '';
  let terminal = false;

  if (state.type === 'threshold') {
    const threshold = parseNumber(state.threshold);
    const met = numeric !== null && threshold !== null &&
      (state.comparator === 'above' ? numeric > threshold : numeric < threshold);
    const previouslyMet = state.thresholdMet === true;
    if (numeric === null) {
      kind = 'unreadable';
      reason = 'no comparable number was observed';
    } else if (met && (!previouslyMet || state.notifyRule === 'ongoing')) {
      // Crossing the threshold is the news. Staying past it is not — re-notifying every cycle
      // afterwards is exactly the noise a watch is supposed to spare the user, unless they
      // explicitly asked for ongoing updates.
      notify = true;
      kind = 'threshold_met';
      reason = `${numeric} is ${state.comparator} ${threshold}`;
      terminal = state.notifyRule === 'once';
    } else if (met) {
      kind = 'still_met';
      reason = `${numeric} is still ${state.comparator} ${threshold} — already reported`;
    } else {
      kind = 'unchanged';
      reason = `${numeric} has not gone ${state.comparator} ${threshold}`;
    }
    state.thresholdMet = met;
  } else if (isFirst) {
    // The first run establishes the baseline. There is nothing to compare against yet, so it
    // is never news — this is what stops "tell me when it comes back in stock" firing
    // immediately just because it read the page for the first time.
    kind = 'baseline';
    reason = 'first observation recorded as the baseline';
  } else {
    const changed = normalized !== normalizeState(previous.state ?? previous.value);
    if (!changed) {
      kind = 'unchanged';
      reason = 'the meaningful state is the same as last time';
    } else {
      kind = 'changed';
      reason = `changed from "${clean(previous.state ?? previous.value, 80)}" to "${clean(normalized, 80)}"`;
      // A target state ("back in stock", "applications open") ends the watch when reached;
      // an open-ended "keep me updated" keeps running.
      const target = normalizeState(state.targetState);
      const hitTarget = target && normalized.includes(target);
      notify = !target || hitTarget;
      if (!notify) {
        kind = 'changed_not_target';
        reason = `${reason}, which is not what you asked to be told about`;
      }
      terminal = Boolean(hitTarget) && state.notifyRule !== 'ongoing';
    }
  }

  if (state.type === 'recurring_check') {
    // A recurring reassessment ("every Friday, who do I still owe a reply to?") has no
    // "nothing changed" state — every run IS the deliverable.
    notify = true;
    kind = 'reassessment';
    reason = 'recurring check — the result itself is the update';
    terminal = false;
  }

  const evaluation = { notify, kind, reason, at, terminal };
  return {
    notify,
    kind,
    reason,
    terminal,
    state: { ...state, baseline, lastObserved: entry, history, lastEvaluation: evaluation }
  };
}

// Asking twice for the same watch adjusts the existing one rather than leaving two polling the
// same page. Light plural stemming, so "hotel prices drop" and "hotel price drops" are one watch.
function stem(token) {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}

const WATCH_STOPWORDS = /\b(the|a|an|my|me|it|its|they|them|for|and|to|of|on|in|if|is|are|when|whether|please|keep|let|know|check|tell|watch|track|still|good|again)\b/g;

function normalizeWatchKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(WATCH_STOPWORDS, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(stem)
    .join(' ');
}

// Denominator is the LARGER set, not the smaller one. With min(), a short generic phrase
// ("hotel price") scores highly against any longer watch that happens to contain those
// words — which merged two unrelated hotel watches during testing. Merging two different
// watches is as damaging as running two copies of one.
function tokenOverlap(a, b) {
  const left = new Set(normalizeWatchKey(a).split(' ').filter(Boolean));
  const right = new Set(normalizeWatchKey(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

const DUPLICATE_OVERLAP = 0.75;

// Deliberately compares the WHAT (source, then title + condition), not the cadence: "check it
// weekly instead" is the same watch with a different schedule, and should update rather than
// duplicate. The source URL is the strongest signal in both directions — two watches on the
// same page are the same watch, and two watches on DIFFERENT pages are never the same one no
// matter how similarly they are worded.
function findDuplicateWatch(existing = [], candidate = {}) {
  const candidateText = `${candidate.title || ''} ${candidate.condition || ''}`;
  const candidateUrl = clean(candidate.source_url || candidate.sourceUrl, 500);
  for (const task of existing) {
    if (task.active === false) continue;
    const taskUrl = clean(task.watch_state?.sourceUrl, 500);
    if (candidateUrl && taskUrl) {
      if (candidateUrl === taskUrl) return task;
      continue;
    }
    const taskText = `${task.title || ''} ${task.condition || ''}`;
    if (tokenOverlap(candidateText, taskText) >= DUPLICATE_OVERLAP) return task;
  }
  return null;
}

// ── User-facing description ────────────────────────────────────────────────────────────

function describeWatch(task = {}) {
  const config = task.watch_state || {};
  const bits = [];
  if (config.type === 'threshold' && config.threshold !== null && config.threshold !== undefined) {
    bits.push(`until it goes ${config.comparator || 'below'} ${config.threshold}`);
  } else if (task.condition) {
    bits.push(`until ${clean(task.condition, 120)}`);
  }
  if (config.sourceUrl) bits.push(`watching ${config.sourceUrl.replace(/^https?:\/\//, '').slice(0, 60)}`);
  const last = config.lastObserved;
  if (last?.value !== undefined && last?.value !== null) bits.push(`last seen: ${clean(last.value, 60)}`);
  if (config.lastEvaluation?.kind === 'blocked') bits.push(`last check failed: ${clean(config.lastEvaluation.reason, 80)}`);
  return bits.join(' · ');
}

function summarizeWatches(tasks = []) {
  if (!tasks.length) return "I'm not watching anything for you right now.";
  const lines = tasks.map(task => {
    const detail = describeWatch(task);
    return `• ${task.title}${detail ? ` — ${detail}` : ''}`;
  });
  return `${tasks.length} thing${tasks.length === 1 ? '' : 's'} I'm watching:\n${lines.join('\n')}`;
}

module.exports = {
  WATCH_TYPES,
  NOTIFY_RULES,
  normalizeState,
  parseNumber,
  buildWatchConfig,
  evaluateObservation,
  normalizeWatchKey,
  tokenOverlap,
  findDuplicateWatch,
  describeWatch,
  summarizeWatches
};
