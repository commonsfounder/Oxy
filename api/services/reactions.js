'use strict';

// A tapped reaction reaches Adam as an ordinary message in this exact shape, so it is kept in the
// conversation for context. Adam answers with QUIET_REPLY when a reply would be noise; that reply is
// never saved or shown.
const REACTION_PATTERN = /^Reacted (\S{1,16}) to “([\s\S]*)”$/u;
const QUIET_REPLY = '[quiet]';

function parseReaction(message) {
  const match = String(message || '').trim().match(REACTION_PATTERN);
  return match ? { emoji: match[1], quoted: match[2] } : null;
}

function isReactionMessage(message) {
  return parseReaction(message) !== null;
}

function isQuietReply(text) {
  return String(text || '').trim().toLowerCase() === QUIET_REPLY;
}

module.exports = { QUIET_REPLY, parseReaction, isReactionMessage, isQuietReply };
