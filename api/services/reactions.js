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

// Adam can answer with a reaction instead of words: exactly [react:EMOJI] and nothing else. The app
// draws it as a badge on the user's message; anywhere that cannot (speech, Telegram) it is the emoji.
const AGENT_REACTION_PATTERN = /^\[react:(\S{1,16})\]$/u;

function parseAgentReaction(text) {
  const match = String(text || '').trim().match(AGENT_REACTION_PATTERN);
  return match ? match[1] : null;
}

function isAgentReaction(text) {
  return parseAgentReaction(text) !== null;
}

// What a surface that cannot show a badge should send or say for a reply.
function plainReply(text) {
  return parseAgentReaction(text) || String(text ?? '');
}

function isQuietReply(text) {
  return String(text || '').trim().toLowerCase() === QUIET_REPLY;
}

module.exports = { QUIET_REPLY, parseReaction, isReactionMessage, isQuietReply, parseAgentReaction, isAgentReaction, plainReply };
