'use strict';

// One spoken turn from a paired home device: its recording in, Adam's spoken reply out.
// The request runs through the same chat pipeline as the phone, as the paired user, so the device
// gets every capability and every authority gate the phone has. What a shared device cannot do is
// approve: approval words are refused before they reach the pipeline, and a reply that is waiting
// on approval is spoken as "it's on your phone", never read out as a question to answer here.

const { validateDeviceCapture, toDeviceWav } = require('./device-audio');
const { validateDisplayAsk } = require('./display-ask');
const reactions = require('./reactions');

const MAX_SPOKEN_CHARS = 600;

const SAY = Object.freeze({
  notHeard: "I didn't catch that.",
  approveOnPhone: 'Approve or cancel that on your phone.',
  waitingOnPhone: "That needs your yes. It's on your phone.",
  done: 'Done.',
  failed: "I couldn't do that just now."
});

function findPendingAction(actions = []) {
  return actions.find(entry => entry?.result?.pending === true || entry?.result?.outcome === 'awaiting_user') || null;
}

// Speech, not text: no markdown, links or list markers, and short enough to listen to. The full
// answer is still in the conversation on the phone.
function spokenText(text) {
  let clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/[*_#`>|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= MAX_SPOKEN_CHARS) return clean;
  const cut = clean.slice(0, MAX_SPOKEN_CHARS);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  clean = sentenceEnd > 80 ? cut.slice(0, sentenceEnd + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}.`;
  return `${clean} The rest is on your phone.`;
}

function replyFor(result) {
  if (findPendingAction(result?.actions || [])) return { text: SAY.waitingOnPhone, kind: 'approval' };
  if (reactions.isQuietReply(result?.text)) return { text: SAY.done, kind: 'answer' };
  const text = spokenText(reactions.plainReply(result?.text || ''));
  return { text: text || SAY.done, kind: 'answer' };
}

// transcribe(wav) -> text; ask(text) -> /chat result; synthesize(text) -> WAV buffer (any PCM rate).
async function deviceVoiceTurn({ audio, transcribe, ask, synthesize }) {
  const capture = validateDeviceCapture(audio);
  const heard = String(await transcribe(capture.wav) || '').replace(/\s+/g, ' ').trim();

  let reply;
  if (!heard) {
    reply = { text: SAY.notHeard, kind: 'not_heard' };
  } else {
    let request = null;
    try {
      request = validateDisplayAsk(heard);
    } catch (error) {
      if (error.code !== 'needs_phone' && error.code !== 'invalid_ask') throw error;
      reply = error.code === 'needs_phone'
        ? { text: SAY.approveOnPhone, kind: 'needs_phone' }
        : { text: SAY.notHeard, kind: 'not_heard' };
    }
    if (request) {
      try {
        reply = replyFor(await ask(request));
      } catch {
        reply = { text: SAY.failed, kind: 'failed' };
      }
    }
  }

  const speech = await synthesize(reply.text);
  return { heard, reply: reply.text, kind: reply.kind, audio: toDeviceWav(speech) };
}

module.exports = { SAY, deviceVoiceTurn, spokenText };
