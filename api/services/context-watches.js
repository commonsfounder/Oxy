'use strict';

const CONTEXT_EVENTS = ['arrive_home', 'leave_home'];
const CONTEXT_METRICS = Object.freeze({
  latest_heart_rate: {
    key: 'latestHeartRate', timestampKey: 'latestHeartRateRecordedAt', label: 'latest heart rate', unit: 'bpm', maxAgeMs: 30 * 60 * 1000
  },
  resting_heart_rate: {
    key: 'restingHeartRate', timestampKey: 'restingHeartRateRecordedAt', label: 'resting heart rate', unit: 'bpm', maxAgeMs: 36 * 60 * 60 * 1000
  },
  steps_today: {
    key: 'stepCountToday', timestampKey: 'capturedAt', label: 'steps today', unit: 'steps', maxAgeMs: 30 * 60 * 1000
  },
  sleep_minutes_last_night: {
    key: 'sleepMinutesLastNight', timestampKey: 'capturedAt', label: 'sleep last night', unit: 'minutes', maxAgeMs: 30 * 60 * 1000
  }
});
const DEFAULT_RADIUS_METRES = 200;
const MAX_RADIUS_METRES = 5000;
const DEFAULT_MAX_CONTEXT_AGE_MS = 30 * 60 * 1000;
const MAX_HISTORY = 10;

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function coordinates(value = {}) {
  const source = parseObject(value);
  const latitude = finiteCoordinate(source.latitude ?? source.lat);
  const longitude = finiteCoordinate(source.longitude ?? source.lng);
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

function normalizeContextEvent(value) {
  const event = String(value || '').trim().toLowerCase();
  return CONTEXT_EVENTS.includes(event) ? event : null;
}

function normalizeContextMetric(value) {
  const metric = String(value || '').trim().toLowerCase();
  return Object.hasOwn(CONTEXT_METRICS, metric) ? metric : null;
}

function normalizeComparator(value) {
  return String(value || '').trim().toLowerCase() === 'above' ? 'above' : 'below';
}

function numbersInText(value) {
  return (String(value || '').match(/-?\d[\d,]*(?:\.\d+)?/g) || [])
    .map(number => Number(number.replace(/,/g, '')))
    .filter(Number.isFinite);
}

function hasMonitoringIntent(value) {
  return /\b(tell me|notify me|alert me|let me know|remind me|watch|monitor|keep an eye)\b/i.test(String(value || ''));
}

function explicitLocationWatchRequest({ event, radiusMetres } = {}, userMessage = '') {
  const normalizedEvent = normalizeContextEvent(event);
  const message = String(userMessage || '').toLowerCase();
  if (!normalizedEvent || !message.trim() || !hasMonitoringIntent(message) || !/\bhome\b/i.test(message)) return false;

  const directionMatches = normalizedEvent === 'arrive_home'
    ? /\b(get|gets|got|arrive|arrives|arriving|come|comes|coming|return|returns|returning|back)\b[^.!?]{0,50}\bhome\b/i.test(message)
    : /\b(leave|leaves|leaving)\b[^.!?]{0,30}\bhome\b/i.test(message);
  if (!directionMatches) return false;

  if (radiusMetres === undefined || radiusMetres === null || radiusMetres === '') return true;
  const requestedRadius = Number(radiusMetres);
  if (!Number.isFinite(requestedRadius)) return false;
  const radiusPattern = /(-?\d[\d,]*(?:\.\d+)?)\s*(metres?|meters?|m|kilometres?|kilometers?|km|miles?|mi)\b/gi;
  const namedRadii = [];
  let match;
  while ((match = radiusPattern.exec(message))) {
    const value = Number(match[1].replace(/,/g, ''));
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(value)) continue;
    const metres = /^(km|kilomet)/.test(unit) ? value * 1000 : /^(mi|mile)/.test(unit) ? value * 1609.344 : value;
    namedRadii.push(metres);
  }
  return namedRadii.some(metres => Math.abs(metres - requestedRadius) <= 1);
}

function explicitMetricWatchRequest({ metric, threshold, comparator } = {}, userMessage = '') {
  const normalizedMetric = normalizeContextMetric(metric);
  const numericThreshold = Number(threshold);
  const message = String(userMessage || '').toLowerCase();
  if (!normalizedMetric || !Number.isFinite(numericThreshold) || !message.trim()) return false;

  const hasWatchIntent = hasMonitoringIntent(message);
  const metricPatterns = {
    latest_heart_rate: /\b(heart rate|pulse|bpm)\b/i,
    resting_heart_rate: /\b(resting heart rate|resting pulse)\b/i,
    steps_today: /\b(steps?|step count)\b/i,
    sleep_minutes_last_night: /\b(sleep|slept)\b/i
  };
  const thresholdNamed = numbersInText(message).some(number => number === numericThreshold);
  if (!hasWatchIntent || !metricPatterns[normalizedMetric].test(message) || !thresholdNamed) return false;

  const requestedComparator = normalizeComparator(comparator);
  if (/\b(below|under|less than|drops? below|falls? below)\b/i.test(message)) return requestedComparator === 'below';
  if (/\b(above|over|more than|passes?|reaches?|exceeds?)\b/i.test(message)) return requestedComparator === 'above';
  return true;
}

function normalizeRadius(value) {
  const radius = Number(value);
  if (!Number.isFinite(radius) || radius <= 0) return DEFAULT_RADIUS_METRES;
  return Math.min(MAX_RADIUS_METRES, Math.round(radius));
}

function buildContextConfig({ event, metric, threshold, comparator, radiusMetres } = {}) {
  const normalizedEvent = normalizeContextEvent(event);
  const normalizedMetric = normalizeContextMetric(metric);
  if (Boolean(normalizedEvent) === Boolean(normalizedMetric)) return null;
  if (normalizedMetric) {
    const numericThreshold = Number(threshold);
    if (!Number.isFinite(numericThreshold)) return null;
    return {
      metric: normalizedMetric,
      source: 'health',
      threshold: numericThreshold,
      comparator: normalizeComparator(comparator),
      lastMet: null,
      transitionCount: 0,
      lastCheckedAt: null
    };
  }
  return {
    event: normalizedEvent,
    target: 'home',
    radiusMetres: normalizeRadius(radiusMetres),
    lastInside: null,
    transitionCount: 0,
    lastCheckedAt: null
  };
}

function isContextWatch(task = {}) {
  const context = task?.watch_state?.context;
  return task?.watch_state?.type === 'context' && Boolean(context?.event || context?.metric);
}

function describeContextEvent(value) {
  const event = normalizeContextEvent(value);
  if (event === 'arrive_home') return 'when you arrive home';
  if (event === 'leave_home') return 'when you leave home';
  return 'when the saved context changes';
}

function describeContextWatch(value = {}) {
  const context = value?.context || value;
  if (context.event) return describeContextEvent(context.event);
  const metric = CONTEXT_METRICS[normalizeContextMetric(context.metric)];
  if (!metric) return 'when the saved context changes';
  const comparator = normalizeComparator(context.comparator);
  return `when your ${metric.label} goes ${comparator} ${context.threshold} ${metric.unit}`;
}

function haversineMetres(left, right) {
  const radius = 6371000;
  const toRadians = degrees => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(right.latitude - left.latitude);
  const deltaLongitude = toRadians(right.longitude - left.longitude);
  const a = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(left.latitude)) * Math.cos(toRadians(right.latitude)) *
    Math.sin(deltaLongitude / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function blockedResult(state, context, reason, at) {
  const repeated = state.lastEvaluation?.kind === 'blocked' && state.lastEvaluation?.reason === reason;
  const evaluation = { notify: !repeated, kind: 'blocked', reason, at, terminal: false };
  return {
    notify: !repeated,
    kind: 'blocked',
    reason,
    terminal: false,
    state: {
      ...state,
      context: { ...context, lastCheckedAt: at },
      lastEvaluation: evaluation
    }
  };
}

function metricResult(state, context, nativeContext, at, now) {
  const metricName = normalizeContextMetric(context.metric);
  const metric = CONTEXT_METRICS[metricName];
  if (!metric) return blockedResult(state, context, 'the health metric is invalid', at);

  const capabilities = parseObject(nativeContext.capabilities);
  if (capabilities.healthKit === false) {
    return blockedResult(state, context, 'Apple Health is unavailable on this device', at);
  }

  const health = parseObject(nativeContext.health);
  const value = Number(health[metric.key]);
  if (!Number.isFinite(value)) {
    return blockedResult(state, context, `${metric.label} is unavailable`, at);
  }

  const recordedAt = Date.parse(health[metric.timestampKey] || '');
  if (!Number.isFinite(recordedAt)) {
    return blockedResult(state, context, `${metric.label} has no source timestamp`, at);
  }
  if (now.getTime() - recordedAt > metric.maxAgeMs) {
    return blockedResult(state, context, `${metric.label} is too old to prove a change`, at);
  }

  const threshold = Number(context.threshold);
  if (!Number.isFinite(threshold)) {
    return blockedResult(state, context, 'the health threshold is invalid', at);
  }

  const comparator = normalizeComparator(context.comparator);
  const met = comparator === 'above' ? value > threshold : value < threshold;
  const previousMet = typeof context.lastMet === 'boolean' ? context.lastMet : null;
  const triggered = previousMet === false && met === true;
  const transitionCount = Number(context.transitionCount || 0) + (triggered ? 1 : 0);
  const terminal = triggered && state.notifyRule !== 'ongoing';
  const kind = triggered ? 'context_triggered' : previousMet === null ? 'baseline' : 'unchanged';
  const reason = triggered
    ? `${metric.label} went ${comparator} ${threshold} ${metric.unit}`
    : previousMet === null ? `${metric.label} recorded as the baseline` : 'the threshold was not newly crossed';
  const entry = {
    at,
    recordedAt: new Date(recordedAt).toISOString(),
    state: met ? 'threshold met' : 'threshold not met',
    value,
    unit: metric.unit
  };
  const evaluation = { notify: triggered, kind, reason, at, terminal };

  return {
    notify: triggered,
    kind,
    reason,
    terminal,
    value,
    state: {
      ...state,
      context: {
        ...context,
        metric: metricName,
        threshold,
        comparator,
        lastMet: met,
        transitionCount,
        lastCheckedAt: at
      },
      baseline: state.baseline || entry,
      lastObserved: entry,
      history: [...(state.history || []), entry].slice(-MAX_HISTORY),
      lastEvaluation: evaluation
    }
  };
}

function evaluateContextWatch(watchState = {}, nativeContext = {}, {
  now = new Date(),
  maxContextAgeMs = DEFAULT_MAX_CONTEXT_AGE_MS
} = {}) {
  const state = { ...watchState };
  const context = { ...(watchState.context || {}) };
  const at = now.toISOString();
  const event = normalizeContextEvent(context.event);
  const metric = normalizeContextMetric(context.metric);
  if (!event && !metric) return blockedResult(state, context, 'the contextual watch is invalid', at);

  const updatedAt = Date.parse(nativeContext.updated_at || nativeContext.updatedAt || '');
  if (Number.isFinite(updatedAt) && now.getTime() - updatedAt > maxContextAgeMs) {
    return blockedResult(state, context, 'the latest device context is too old to prove a change', at);
  }

  if (metric) return metricResult(state, context, nativeContext, at, now);

  const settings = parseObject(nativeContext.settings);
  if (settings.locationReminders === false) {
    return blockedResult(state, context, 'location reminders are turned off', at);
  }

  const current = coordinates(nativeContext.location);
  if (!current) return blockedResult(state, context, 'current location is unavailable', at);

  const home = coordinates(settings.homeLocation || nativeContext.homeLocation);
  if (!home) return blockedResult(state, context, 'home location is not set', at);

  const distanceMetres = haversineMetres(current, home);
  const inside = distanceMetres <= normalizeRadius(context.radiusMetres);
  const previousInside = typeof context.lastInside === 'boolean' ? context.lastInside : null;
  const triggered = previousInside !== null && (
    event === 'arrive_home'
      ? previousInside === false && inside === true
      : previousInside === true && inside === false
  );
  const transitionCount = Number(context.transitionCount || 0) + (triggered ? 1 : 0);
  const terminal = triggered && watchState.notifyRule !== 'ongoing';
  const kind = triggered ? 'context_triggered' : previousInside === null ? 'baseline' : 'unchanged';
  const reason = triggered
    ? (event === 'arrive_home' ? 'arrived home' : 'left home')
    : previousInside === null ? 'current location recorded as the baseline' : 'no matching location transition';
  const entry = {
    at,
    state: inside ? 'inside home radius' : 'outside home radius',
    value: Math.round(distanceMetres)
  };
  const evaluation = { notify: triggered, kind, reason, at, terminal };

  return {
    notify: triggered,
    kind,
    reason,
    terminal,
    distanceMetres,
    state: {
      ...state,
      context: { ...context, event, radiusMetres: normalizeRadius(context.radiusMetres), lastInside: inside, transitionCount, lastCheckedAt: at },
      baseline: state.baseline || entry,
      lastObserved: entry,
      history: [...(state.history || []), entry].slice(-MAX_HISTORY),
      lastEvaluation: evaluation
    }
  };
}

module.exports = {
  CONTEXT_EVENTS,
  CONTEXT_METRICS,
  DEFAULT_RADIUS_METRES,
  MAX_RADIUS_METRES,
  DEFAULT_MAX_CONTEXT_AGE_MS,
  buildContextConfig,
  explicitLocationWatchRequest,
  explicitMetricWatchRequest,
  isContextWatch,
  describeContextEvent,
  describeContextWatch,
  haversineMetres,
  evaluateContextWatch
};
