'use strict';

// Home is the current state of the world as Adam can know it: where its devices are, whether they're
// listening, what it's watching, and what it has sensed. It is not a history of the conversation.
//
// Observations are a distinct kind of thing from chat messages and from actions: they come from
// devices and sensors, carry a room, and say whether they were sensed directly or inferred. No
// hardware reports them yet, so callers pass an empty list; the shape is pinned by tests so the
// feed that fills it in later has one place to land.

const ONLINE_WINDOW_MS = 3 * 60 * 1000;
const MAX_OBSERVATIONS = 10;
const SOURCES = Object.freeze(['sensor', 'inferred', 'reported']);

function clean(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validDate(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeDevice(display, now) {
  const seen = validDate(display?.lastSeenAt);
  const online = Boolean(seen) && now.getTime() - seen.getTime() <= ONLINE_WINDOW_MS && seen.getTime() <= now.getTime() + 60 * 1000;
  const capabilities = display?.capabilities && typeof display.capabilities === 'object'
    ? Object.keys(display.capabilities).filter(key => display.capabilities[key] === true)
    : [];
  return {
    id: String(display?.id || ''),
    name: clean(display?.name, 60) || 'Adam speaker',
    kind: clean(display?.type, 30) || 'speaker',
    room: clean(display?.room, 40) || null,
    online,
    lastSeenAt: seen ? seen.toISOString() : null,
    capabilities
  };
}

function normalizeObservation(raw, now) {
  const at = validDate(raw?.at);
  const summary = clean(raw?.summary, 140);
  if (!at || !summary || at.getTime() > now.getTime() + 60 * 1000) return null;
  const source = SOURCES.includes(raw?.source) ? raw.source : 'reported';
  return {
    id: String(raw?.id || `${at.getTime()}-${summary}`),
    kind: clean(raw?.kind, 40) || 'event',
    room: clean(raw?.room, 40) || null,
    summary,
    at: at.toISOString(),
    source
  };
}

// A watch is a scheduled check that has a condition to look for, as opposed to a plain reminder.
function normalizeWatches(rows = [], now) {
  return rows
    .filter(row => row?.active !== false && clean(row?.title) && (row?.condition || row?.context_event || row?.watch_state))
    .map(row => {
      const next = validDate(row.next_run_at || row.nextRunAt);
      const fresh = next && next.getTime() >= now.getTime() - 5 * 60 * 1000;
      return {
        id: String(row.id || row.title),
        title: clean(row.title),
        detail: clean(row.condition, 140) || null,
        nextRunAt: fresh ? next.toISOString() : null
      };
    })
    .slice(0, 12);
}

function buildHomeModel({ displays = [], presence = null, scheduledRows = [], observations = [], now = new Date() } = {}) {
  const devices = displays.map(display => normalizeDevice(display, now)).filter(device => device.id);
  const rooms = new Map();
  for (const device of devices) {
    if (!device.room) continue;
    if (!rooms.has(device.room)) rooms.set(device.room, []);
    rooms.get(device.room).push(device);
  }
  const sensed = observations.map(item => normalizeObservation(item, now)).filter(Boolean)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_OBSERVATIONS);

  return {
    generatedAt: now.toISOString(),
    presence: presence || { state: 'unknown', observedAt: null, homeConfigured: false },
    devices,
    rooms: [...rooms.entries()].map(([name, roomDevices]) => ({
      name,
      devices: roomDevices,
      active: roomDevices.some(device => device.online)
    })),
    unassignedDevices: devices.filter(device => !device.room),
    watches: normalizeWatches(scheduledRows, now),
    observations: sensed
  };
}

module.exports = { ONLINE_WINDOW_MS, SOURCES, normalizeDevice, normalizeObservation, buildHomeModel };
