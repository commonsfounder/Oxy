'use strict';

// The pieces Adam's scenes are built from. We drew them once, so they look right every time; the
// model only chooses which ones appear and what happens to them (see scene-spec.js).

const PIECES = {
  radiator: '<rect x="8" y="14" width="44" height="34" rx="5"/><path d="M18 20v22M26 20v22M34 20v22M42 20v22"/><path d="M8 26H4v14h4M52 26h4v14h-4"/><circle cx="47" cy="9" r="3.5" style="stroke:var(--accent)"/>',
  valve: '<path d="M24 22h16l8 12-8 12H24l-8-12z"/><circle cx="32" cy="34" r="5" style="stroke:var(--accent)"/><path d="M32 8v14"/>',
  key: '<circle cx="20" cy="22" r="9"/><path d="M27 29l24 24M43 45l6-6M36 52l5-5"/>',
  turn: '<path d="M47 19a19 19 0 1 0 4 14"/><path d="M51 9v11H40" style="stroke:var(--accent)"/>',
  drop: '<path d="M32 8c10 14 16 22 16 32a16 16 0 0 1-32 0c0-10 6-18 16-32z"/>',
  bubbles: '<circle cx="22" cy="44" r="7"/><circle cx="40" cy="32" r="5"/><circle cx="29" cy="16" r="3.5"/>',
  cloth: '<path d="M12 14h40v30c-7 8-13-5-20 1s-13-7-20 0z"/><path d="M12 24h40"/>',
  clock: '<circle cx="32" cy="32" r="22"/><path d="M32 18v14l9 6" style="stroke:var(--accent)"/>',
  pot: '<path d="M12 28h40v16a8 8 0 0 1-8 8H20a8 8 0 0 1-8-8z"/><path d="M8 28h48M24 20c0-4 3-4 3-9M36 20c0-4 3-4 3-9"/>',
  oven: '<rect x="10" y="10" width="44" height="44" rx="6"/><path d="M10 23h44"/><circle cx="20" cy="16.5" r="2"/><circle cx="30" cy="16.5" r="2"/><rect x="18" y="30" width="28" height="16" rx="3"/>',
  person: '<circle cx="32" cy="20" r="9"/><path d="M14 54c2-12 10-18 18-18s16 6 18 18"/>',
  house: '<path d="M8 30L32 10l24 20"/><path d="M14 26v26h36V26"/><path d="M27 52V38h10v14"/>',
  train: '<rect x="14" y="8" width="36" height="38" rx="8"/><path d="M14 28h36"/><circle cx="24" cy="37" r="2"/><circle cx="40" cy="37" r="2"/><path d="M22 46l-6 10M42 46l6 10"/>',
  check: '<circle cx="32" cy="32" r="22"/><path d="M22 33l7 7 14-15" style="stroke:var(--accent)"/>',
  alert: '<path d="M32 8L58 52H6z"/><path d="M32 24v14M32 45v1" style="stroke:var(--accent)"/>',
  bulb: '<path d="M24 44c0-6-8-8-8-18a16 16 0 0 1 32 0c0 10-8 12-8 18z"/><path d="M26 52h12M28 58h8"/>',
  'arrow-right': '<path d="M10 32h40M38 20l12 12-12 12"/>',
  'arrow-down': '<path d="M32 10v40M20 38l12 12 12-12"/>',
  calendar: '<rect x="10" y="14" width="44" height="40" rx="6"/><path d="M10 26h44M22 8v12M42 8v12"/>',
  heat: '<path d="M26 10a6 6 0 0 1 12 0v26a12 12 0 1 1-12 0z"/><circle cx="32" cy="46" r="5" style="stroke:var(--accent)"/>',
  bell: '<path d="M16 42V28a16 16 0 0 1 32 0v14l4 6H12z"/><path d="M27 54a5 5 0 0 0 10 0"/>',
  play: '<path d="M22 14l26 18-26 18z"/>',
  pause: '<path d="M22 14v36M42 14v36"/>',
  replay: '<path d="M50 32a18 18 0 1 1-6-13"/><path d="M47 8v12H35"/>'
};

const PIECE_NAMES = Object.keys(PIECES);

const SPRITE = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'
  + PIECE_NAMES.map(name => `<symbol id="p-${name}" viewBox="0 0 64 64">${PIECES[name]}</symbol>`).join('')
  + '</defs></svg>';

const PIECE_CSS = `
.pic{width:220px;height:220px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;flex:none}
.pic.acc{stroke:var(--accent)}.pic.xl{width:340px;height:340px}.pic.sm{width:96px;height:96px}.pic.xs{width:56px;height:56px}
`;

module.exports = { PIECES, PIECE_NAMES, SPRITE, PIECE_CSS };
