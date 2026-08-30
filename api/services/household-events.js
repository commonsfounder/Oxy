'use strict';

// Generic environmental events and the small deterministic decision made before Adam
// interrupts someone. Producers supply observations; this module does not invent them.

const EVENT_TYPES = Object.freeze([
  'person_arrived',
  'person_left',
  'person_near_door',
  'delivery_due',
  'delivery_arrived',
  'timer_finished',
  'device_state_changed',
  'sound_detected',
  'calendar_event_approaching',
  'item_running_low',
  'commitment_due',
  'household_state_changed'
]);

const INTERRUPTION_COSTS = Object.freeze(['low', 'normal', 'high']);
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const MIN_CONFIDENCE = 0.6;
const MIN_RELEVANCE = 0.5;
const MAX_EVENTS = 12;
const MAX_ID = 120;
const MAX_SUBJECT = 240;
const MAX_TITLE = 160;
const MAX_BODY = 2000;
const MAX_PERSON = 100;
const MAX_ROOM = 80;
const MAX_SOURCE = 80;

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isoDate(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function boundedScore(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function normalizeHouseholdEvent(input = {}, now = new Date()) {
  const type = String(input.type || '').trim().toLowerCase();
  if (!EVENT_TYPES.includes(type)) return null;

  const subject = clean(input.subject || input.title || type, MAX_SUBJECT);
  if (!subject) return null;
  const occurredAt = isoDate(input.occurredAt || input.occurred_at) || isoDate(now);
  const expiresAt = isoDate(input.expiresAt || input.expires_at);
  const interruptionCost = INTERRUPTION_COSTS.includes(input.interruptionCost)
    ? input.interruptionCost
    : 'normal';

  return {
    id: clean(input.id, MAX_ID) || `${type}:${occurredAt}`,
    type,
    subject,
    title: clean(input.title || subject, MAX_TITLE),
    body: clean(input.body || subject, MAX_BODY),
    personName: clean(input.personName || input.person_name, MAX_PERSON) || null,
    room: clean(input.room, MAX_ROOM) || null,
    occurredAt,
    expiresAt,
    source: clean(input.source, MAX_SOURCE) || 'environment',
    confidence: boundedScore(input.confidence),
    relevance: boundedScore(input.relevance),
    actionable: input.actionable !== false,
    urgent: input.urgent === true,
    requiresNow: input.requiresNow === true,
    solveSilently: input.solveSilently === true,
    interruptionCost
  };
}

function normalizeHouseholdEvents(input, now = new Date()) {
  if (!Array.isArray(input)) return [];
  return input
    .map(event => normalizeHouseholdEvent(event, now))
    .filter(Boolean)
    .slice(0, MAX_EVENTS);
}

function householdEventDedupeKey(event = {}) {
  const type = EVENT_TYPES.includes(event.type) ? event.type : 'household_state_changed';
  const id = clean(event.id, MAX_ID) || `${type}:${isoDate(event.occurredAt) || 'unknown'}`;
  return `household:${type}:${id}`.slice(0, 240);
}

function notificationCategoryForHouseholdEvent(event = {}) {
  if (event.type === 'delivery_due' || event.type === 'delivery_arrived') return 'delivery';
  if (event.type === 'commitment_due' || event.type === 'item_running_low') return 'commitment';
  if (event.type === 'calendar_event_approaching') return 'action_required';
  return 'other';
}

function decideIntervention({ event, now = new Date(), lastSurfacedAt = null, userCanActNow = true, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const current = event && typeof event === 'object' ? event : null;
  if (!current) return { surface: false, reason: 'invalid_event' };

  const at = new Date(now).getTime();
  const expires = current.expiresAt ? Date.parse(current.expiresAt) : NaN;
  if (Number.isFinite(expires) && Number.isFinite(at) && expires <= at) {
    return { surface: false, reason: 'expired' };
  }
  if (current.solveSilently) return { surface: false, reason: 'solved_silently' };
  if (Number(current.confidence) < MIN_CONFIDENCE) return { surface: false, reason: 'low_confidence' };
  if (Number(current.relevance) < MIN_RELEVANCE) return { surface: false, reason: 'low_relevance' };
  if (current.requiresNow && userCanActNow === false) {
    return { surface: false, reason: 'cannot_act_now', deferred: true };
  }
  if (current.interruptionCost === 'high' && !current.urgent && !current.requiresNow) {
    return { surface: false, reason: 'high_interruption_cost' };
  }

  const last = Date.parse(lastSurfacedAt || '');
  if (Number.isFinite(last) && Number.isFinite(at) && at - last < cooldownMs) {
    return { surface: false, reason: 'cooldown' };
  }
  if (!current.actionable && !current.urgent) return { surface: false, reason: 'not_actionable' };

  return {
    surface: true,
    urgency: current.urgent ? 'urgent' : current.requiresNow ? 'normal' : 'low',
    reason: 'relevant_actionable_event'
  };
}

function interventionReceipt(event = {}) {
  return {
    title: clean(event.title || event.subject, MAX_TITLE),
    body: clean(event.body || event.subject, MAX_BODY),
    sourceRef: {
      householdEventId: clean(event.id, MAX_ID),
      eventType: EVENT_TYPES.includes(event.type) ? event.type : 'household_state_changed'
    }
  };
}

module.exports = {
  EVENT_TYPES,
  INTERRUPTION_COSTS,
  DEFAULT_COOLDOWN_MS,
  MIN_CONFIDENCE,
  MIN_RELEVANCE,
  MAX_EVENTS,
  normalizeHouseholdEvent,
  normalizeHouseholdEvents,
  householdEventDedupeKey,
  notificationCategoryForHouseholdEvent,
  decideIntervention,
  interventionReceipt
};
