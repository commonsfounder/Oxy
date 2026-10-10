'use strict';
// One plain line per action for the phone's working pill, specific when the input allows.
// Start and finish must produce the same line: the phone matches them by text.

const { ACTION_WORDING } = require('../action-wording');

const LINES = Object.fromEntries(
  Object.entries(ACTION_WORDING).filter(([, wording]) => wording.progress).map(([type, wording]) => [type, wording.progress])
);

// An unknown action gets a plain phrase, never its internal name.
function progressLine(type, input = {}) {
  const line = LINES[type];
  if (!line) return 'Working on it';
  try {
    return line(input && typeof input === 'object' ? input : {}) || 'Working on it';
  } catch {
    return 'Working on it';
  }
}

module.exports = { progressLine, PROGRESS_LINES: LINES };
