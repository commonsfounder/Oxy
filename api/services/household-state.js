'use strict';

const { DEFAULT_RADIUS_METRES, haversineMetres } = require('./context-watches');

const DEFAULT_MAX_CONTEXT_AGE_MS = 30 * 60 * 1000;
const MAX_PEOPLE = 16;
const MAX_COMMITMENTS = 12;
const MAX_PLANS = 12;
const MAX_TEXT = 180;

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clean(value, max = MAX_TEXT) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function coordinate(value) {
  const source = parseObject(value);
  const latitude = Number(source.latitude ?? source.lat);
  const longitude = Number(source.longitude ?? source.lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

function isoDate(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizePresence(nativeContext = {}, now = new Date(), maxContextAgeMs = DEFAULT_MAX_CONTEXT_AGE_MS) {
  const settings = parseObject(nativeContext.settings);
  const home = coordinate(settings.homeLocation || nativeContext.homeLocation);
  const location = coordinate(nativeContext.location);
  const observedAt = isoDate(nativeContext.updated_at || nativeContext.updatedAt);
  const observedMs = observedAt ? Date.parse(observedAt) : NaN;
  const fresh = Number.isFinite(observedMs)
    && observedMs <= now.getTime()
    && now.getTime() - observedMs <= maxContextAgeMs;
  const distance = home && location ? haversineMetres(location, home) : null;
  const radius = Number(settings.homeRadiusMetres);
  const radiusMetres = Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_RADIUS_METRES;

  return {
    state: fresh && distance !== null ? (distance <= radiusMetres ? 'home' : 'away') : 'unknown',
    observedAt,
    homeConfigured: home !== null,
    locationRemindersEnabled: settings.locationReminders !== false
  };
}

function normalizePeople(people = []) {
  const seen = new Set();
  const rows = Array.isArray(people) ? people : [];
  return rows.map(person => {
    const name = clean(person?.display_name || person?.name, 100);
    if (!name) return null;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    return { name, relationship: clean(person?.relationship, 60) || null };
  }).filter(Boolean).slice(0, MAX_PEOPLE);
}

function normalizeCommitments(commitments = []) {
  const rows = Array.isArray(commitments) ? commitments : [];
  return rows
    .filter(commitment => String(commitment?.status || 'open').toLowerCase() === 'open')
    .map(commitment => {
      const what = clean(commitment.what);
      if (!what) return null;
      return {
        what,
        personName: clean(commitment.person_name || commitment.personName, 100) || null,
        dueAt: isoDate(commitment.due_at || commitment.dueAt)
      };
    })
    .filter(Boolean)
    .slice(0, MAX_COMMITMENTS);
}

function normalizePlans(scheduledTasks = []) {
  const rows = Array.isArray(scheduledTasks) ? scheduledTasks : [];
  return rows
    .filter(task => task?.active !== false)
    .map(task => {
      const title = clean(task.title);
      if (!title) return null;
      const context = parseObject(task.watch_state).context || {};
      return {
        title,
        recurrence: clean(task.recurrence, 40) || null,
        nextRunAt: isoDate(task.next_run_at || task.nextRunAt),
        contextEvent: clean(task.context_event || task.contextEvent || context.event, 60) || null
      };
    })
    .filter(Boolean)
    .slice(0, MAX_PLANS);
}

function normalizeHouseholdState({
  nativeContext = {},
  people = [],
  commitments = [],
  scheduledTasks = [],
  now = new Date(),
  maxContextAgeMs = DEFAULT_MAX_CONTEXT_AGE_MS
} = {}) {
  const at = new Date(now);
  const generatedAt = Number.isFinite(at.getTime()) ? at.toISOString() : new Date().toISOString();
  return {
    generatedAt,
    presence: normalizePresence(nativeContext, at, maxContextAgeMs),
    people: normalizePeople(people),
    openCommitments: normalizeCommitments(commitments),
    activePlans: normalizePlans(scheduledTasks)
  };
}

function formatHouseholdState(state = {}) {
  const presence = state.presence?.state || 'unknown';
  const people = (Array.isArray(state.people) ? state.people : []).map(person =>
    person.relationship ? `${person.name} (${person.relationship})` : person.name
  ).join(', ') || 'none saved';
  const commitments = (Array.isArray(state.openCommitments) ? state.openCommitments : []).map(commitment => {
    const who = commitment.personName ? ` for ${commitment.personName}` : '';
    return `${commitment.what}${who}`;
  }).join('; ') || 'none open';
  const plans = (Array.isArray(state.activePlans) ? state.activePlans : []).map(plan => plan.title).join('; ') || 'none active';
  return `Household state: presence ${presence}; people ${people}; open obligations ${commitments}; active plans ${plans}.`;
}

module.exports = {
  DEFAULT_MAX_CONTEXT_AGE_MS,
  MAX_PEOPLE,
  MAX_COMMITMENTS,
  MAX_PLANS,
  normalizePresence,
  normalizePeople,
  normalizeCommitments,
  normalizePlans,
  normalizeHouseholdState,
  formatHouseholdState
};
