'use strict';

// The scene format. The model says what appears, how it changes over time, and what can be tapped;
// Adam's own renderer decides how that looks. It is data only: no HTML, CSS, script or paths, so
// there is nothing in it that can act, and every field is checked and clamped before it is stored.
//
//   { title, visual?: { things: [...] }, panel?: [...], beats: [{ say?, secs?, do?: [...] }], asks?: [...] }
//
// The picture is pieces (and rings) that Adam lays out by count, plus connectors between them by id; the
// model never places anything. Panel blocks stack beside or below it. A thing that some beat shows
// starts hidden; a thing no beat mentions is simply there.

const { PIECE_NAMES } = require('./display-scene-kit');

const MAX_THINGS = 16;
const MAX_SLOTS = 8;
const MAX_PANEL = 8;
const MAX_BEATS = 20;
const MAX_DO = 8;
const MAX_SAY_WORDS = 45;
const VERBS = ['show', 'hide', 'focus', 'dim', 'move', 'turn', 'count', 'trace', 'pulse', 'set', 'progress', 'step', 'flow'];
const PIECES = PIECE_NAMES.filter(name => !['play', 'pause', 'replay'].includes(name));
const ID = /^[a-z][a-z0-9_-]{0,23}$/;
const CLOCK = /^([01]?\d|2[0-3]):[0-5]\d$/;

function specError(message) {
  const error = new Error(message);
  error.code = 'invalid_content';
  error.status = 400;
  return error;
}

function str(value, max, where) {
  if (typeof value !== 'string') throw specError(`${where} must be text.`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw specError(`${where} cannot be empty.`);
  return text.slice(0, max);
}

function optStr(value, max, where) {
  return value == null || value === '' ? undefined : str(value, max, where);
}

function num(value, min, max, where, fallback) {
  if (value == null && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw specError(`${where} must be a number.`);
  return Math.min(max, Math.max(min, n));
}

function point(value, where) {
  if (!Array.isArray(value) || value.length !== 2) throw specError(`${where} must be [x, y] between 0 and 100.`);
  return [num(value[0], 0, 100, where), num(value[1], 0, 100, where)];
}

function clock(value, where) {
  const text = String(value ?? '').trim();
  if (!CLOCK.test(text)) throw specError(`${where} must be a 24-hour time like 17:30.`);
  const [h, m] = text.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

function thing(raw, where) {
  if (!raw || typeof raw !== 'object') throw specError(`${where} must be an object.`);
  const id = String(raw.id || '');
  if (!ID.test(id)) throw specError(`${where} needs an id of lowercase letters, numbers, - or _ (like "valve").`);
  const type = raw.type;
  const base = { id, type };
  if (raw.accent === true) base.accent = true;
  switch (type) {
    case 'piece':
      if (!PIECES.includes(raw.piece)) {
        throw specError(`${where}: there is no piece called ${raw.piece}. Pieces: ${PIECES.join(', ')}.`);
      }
      return { ...base, piece: raw.piece, label: optStr(raw.label, 28, `${where}.label`) };
    case 'ring':
      return { ...base, value: num(raw.value, 0, 1, `${where}.value`, 0), label: optStr(raw.label, 24, `${where}.label`) };
    case 'line': case 'arrow': case 'flow':
      return { ...base, from: String(raw.from || ''), to: String(raw.to || ''), dashed: raw.dashed === true };
    default:
      throw specError(`${where} has an unknown type "${type}". Picture types: piece, ring, and connectors line, arrow, flow (between ids). You do not place things; Adam lays them out.`);
  }
}

function block(raw, where) {
  if (!raw || typeof raw !== 'object') throw specError(`${where} must be an object.`);
  const id = String(raw.id || '');
  if (!ID.test(id)) throw specError(`${where} needs an id of lowercase letters, numbers, - or _.`);
  const base = { id, type: raw.type };
  switch (raw.type) {
    case 'text':
      return { ...base, text: str(raw.text, 200, `${where}.text`), style: ['h', 't', 'sub'].includes(raw.style) ? raw.style : 't' };
    case 'number':
      return { ...base, value: num(raw.value, -1e9, 1e9, `${where}.value`), unit: optStr(raw.unit, 16, `${where}.unit`), label: optStr(raw.label, 40, `${where}.label`), decimals: num(raw.decimals, 0, 2, `${where}.decimals`, 0) };
    case 'bars': {
      if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 8) throw specError(`${where}.items needs 1 to 8 items.`);
      return { ...base, unit: optStr(raw.unit, 12, `${where}.unit`), items: raw.items.map((item, k) => ({ label: str(item?.label, 30, `${where}.items[${k}].label`), value: num(item?.value, 0, 1e9, `${where}.items[${k}].value`) })) };
    }
    case 'timeline': {
      if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 10) throw specError(`${where}.items needs 1 to 10 items.`);
      return {
        ...base,
        end: raw.end ? clock(raw.end, `${where}.end`) : undefined,
        items: raw.items.map((item, k) => ({
          label: str(item?.label, 30, `${where}.items[${k}].label`),
          from: clock(item?.from, `${where}.items[${k}].from`),
          to: item?.to ? clock(item.to, `${where}.items[${k}].to`) : undefined
        }))
      };
    }
    case 'timer':
      if (raw.to == null && raw.secs == null) throw specError(`${where} needs "to" (a time like 19:00) or "secs".`);
      return { ...base, label: optStr(raw.label, 40, `${where}.label`), to: raw.to != null ? clock(raw.to, `${where}.to`) : undefined, secs: raw.secs != null ? num(raw.secs, 1, 86400, `${where}.secs`) : undefined };
    case 'steps': {
      if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 8) throw specError(`${where}.items needs 1 to 8 items.`);
      return { ...base, items: raw.items.map((item, k) => str(item, 90, `${where}.items[${k}]`)) };
    }
    case 'compare': {
      if (!Array.isArray(raw.items) || raw.items.length < 2 || raw.items.length > 3) throw specError(`${where}.items needs 2 or 3 options.`);
      return {
        ...base,
        items: raw.items.map((item, k) => ({
          title: str(item?.title, 40, `${where}.items[${k}].title`),
          facts: (Array.isArray(item?.facts) ? item.facts : []).slice(0, 4).map((fact, j) => ({
            label: str(fact?.label, 24, `${where}.items[${k}].facts[${j}].label`),
            value: str(fact?.value, 30, `${where}.items[${k}].facts[${j}].value`)
          })),
          ask: optStr(item?.ask, 120, `${where}.items[${k}].ask`)
        }))
      };
    }
    default:
      throw specError(`${where} has an unknown type "${raw.type}". Panel types: text, number, bars, timeline, timer, steps, compare.`);
  }
}

const NEEDS = {
  count: ['number'], progress: ['ring'], step: ['steps'], set: ['text', 'piece', 'ring'],
  trace: ['line', 'arrow', 'flow'], flow: ['line', 'arrow', 'flow'], turn: ['piece'], move: ['piece', 'ring']
};

function step(raw, where, types) {
  if (!raw || typeof raw !== 'object') throw specError(`${where} must be an object.`);
  const verb = raw.verb;
  if (!VERBS.includes(verb)) throw specError(`${where}: unknown verb "${verb}". Verbs: ${VERBS.join(', ')}.`);
  const out = { verb };
  if (raw.id != null) {
    const id = String(raw.id);
    if (!types.has(id)) throw specError(`${where}: there is nothing called "${id}" on the stage.`);
    out.id = id;
    if (NEEDS[verb] && !NEEDS[verb].includes(types.get(id))) {
      throw specError(`${where}: "${verb}" works on ${NEEDS[verb].join(', ')}, but "${id}" is a ${types.get(id)}.`);
    }
  } else if (verb !== 'focus') {
    throw specError(`${where}: "${verb}" needs an id.`);
  }
  if (verb === 'move') {
    const target = String(raw.to || '');
    if (!types.has(target) || !['piece', 'ring'].includes(types.get(target))) {
      throw specError(`${where}: "move" needs "to" set to the id of a piece or ring to move toward.`);
    }
    out.to = target;
  }
  if (verb === 'turn') out.deg = num(raw.deg, -720, 720, `${where}.deg`);
  if (verb === 'count' || verb === 'progress') out.value = num(raw.value, -1e9, 1e9, `${where}.value`);
  if (verb === 'set') out.text = str(raw.text, 120, `${where}.text`);
  if (verb === 'step') out.n = Math.round(num(raw.n, 1, 8, `${where}.n`));
  return out;
}

function validateScene(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw specError('The scene must be a JSON object.'); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw specError('The scene must be a JSON object.');
  const spec = { title: str(raw.title, 80, 'title') };
  const types = new Map();

  const things = raw.visual?.things;
  if (things != null) {
    if (!Array.isArray(things) || things.length > MAX_THINGS) throw specError(`visual.things can have up to ${MAX_THINGS} things.`);
    spec.visual = { things: things.map((t, k) => thing(t, `visual.things[${k}]`)) };
    for (const t of spec.visual.things) {
      if (types.has(t.id)) throw specError(`The id "${t.id}" is used twice.`);
      types.set(t.id, t.type);
    }
    const slots = spec.visual.things.filter(t => t.type === 'piece' || t.type === 'ring');
    if (!slots.length) throw specError('The picture needs at least one piece or ring.');
    if (slots.length > MAX_SLOTS) throw specError(`The picture can show up to ${MAX_SLOTS} pieces; keep it simple.`);
    for (const t of spec.visual.things.filter(x => !['piece', 'ring'].includes(x.type))) {
      for (const end of [t.from, t.to]) {
        if (!slots.some(slot => slot.id === end)) {
          throw specError(`The ${t.type} "${t.id}" must go from one piece's id to another's, but "${end}" is not a piece or ring.`);
        }
      }
    }
  }
  if (raw.panel != null) {
    if (!Array.isArray(raw.panel) || raw.panel.length > MAX_PANEL) throw specError(`panel can have up to ${MAX_PANEL} blocks.`);
    spec.panel = raw.panel.map((b, k) => block(b, `panel[${k}]`));
    for (const b of spec.panel) {
      if (types.has(b.id)) throw specError(`The id "${b.id}" is used twice.`);
      types.set(b.id, b.type);
    }
  }
  if (!spec.visual && !spec.panel) throw specError('A scene needs a visual, a panel, or both.');

  if (!Array.isArray(raw.beats) || !raw.beats.length || raw.beats.length > MAX_BEATS) {
    throw specError(`beats needs 1 to ${MAX_BEATS} beats.`);
  }
  spec.beats = raw.beats.map((beat, k) => {
    const where = `beats[${k}]`;
    const say = optStr(beat?.say, 400, `${where}.say`);
    if (say && say.split(' ').length > MAX_SAY_WORDS) throw specError(`${where}.say is too long (keep it under ${MAX_SAY_WORDS} words).`);
    const steps = beat?.do == null ? [] : beat.do;
    if (!Array.isArray(steps) || steps.length > MAX_DO) throw specError(`${where}.do can have up to ${MAX_DO} actions.`);
    const out = { do: steps.map((s, j) => step(s, `${where}.do[${j}]`, types)) };
    if (say) out.say = say;
    if (beat?.secs != null) out.secs = num(beat.secs, 2, 30, `${where}.secs`);
    return out;
  });
  if (raw.asks != null) {
    if (!Array.isArray(raw.asks)) throw specError('asks must be a list of short follow-up requests.');
    spec.asks = raw.asks.slice(0, 3).map((a, k) => str(a, 80, `asks[${k}]`));
  }
  return spec;
}

module.exports = { MAX_BEATS, MAX_THINGS, MAX_SLOTS, MAX_PANEL, VERBS, PIECES, validateScene };
