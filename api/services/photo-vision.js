'use strict';

// Turns one of the user's own photos into a short note so it can be found later. The picture is
// looked at once and never stored; only the note is kept (see photo-notes.js).

const PROMPT = `You are helping a personal assistant remember what is in a photo from the user's own camera roll, so it can be found later, and notice when the photo is something the user probably needs help with.
Reply with JSON only: {"note": string, "offer": null | {"ask": string, "prompt": string}}.
"note": one or two plain sentences saying what the photo shows: the main things, clothing or products (colours and brands if visible), the setting, and how many people (never who they are). Include readable text that matters, such as names, dates, amounts and product names. For a document, receipt or screenshot, say what kind and the key facts.
"offer": only when the photo clearly asks for action, such as an event flyer or invitation (add it to the calendar), a bill or invoice (pay it or set a reminder), a product screenshot (find it or find it cheaper), an address or booking confirmation. "ask" is one short friendly question to the user ("Want me to add Sunday market to your calendar?"). "prompt" is what the user would be asking Adam to do, written as the user ("Add the Sunday market on 26 Oct, 11am, to my calendar."). Otherwise null. Never offer for ordinary photos of people, food, pets or scenery.
Do not guess identities. If the photo is private or sensitive (nudity, ID documents, bank cards, passwords, medical records), reply with exactly SKIP.`;

const MAX_BYTES = 700 * 1024;

function buildPrompt({ date, place, text } = {}) {
  const hints = [
    date ? `Taken: ${String(date).slice(0, 10)}.` : '',
    place ? `Near: ${String(place).slice(0, 60)}.` : '',
    text ? `Text the phone could already read in it: "${String(text).slice(0, 300)}".` : ''
  ].filter(Boolean).join(' ');
  return hints ? `${PROMPT}\n\n${hints}` : PROMPT;
}

async function describePhoto({ generate, image, mimeType = 'image/jpeg', context = {} }) {
  if (!image || !image.length) return { skipped: true, reason: 'empty' };
  if (image.length > MAX_BYTES) return { skipped: true, reason: 'too_large' };
  const res = await generate({
    contents: [{ role: 'user', parts: [{ text: buildPrompt(context) }, { inlineData: { mimeType, data: Buffer.from(image).toString('base64') } }] }],
    config: { maxOutputTokens: 400, reasoningEffort: 'low' }
  });
  const text = String(res?.text || '').replace(/\s+/g, ' ').trim();
  if (!text || /^skip\b/i.test(text)) return { skipped: true, reason: 'sensitive_or_empty' };
  const parsed = parseReply(text);
  return { note: parsed.note, offer: parsed.offer, date: context.date || null };
}

// The model is asked for JSON; plain text still works as a note with no offer.
function parseReply(text) {
  const stripped = text.replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const json = JSON.parse(stripped);
    const note = String(json?.note || '').trim();
    const ask = String(json?.offer?.ask || '').trim().slice(0, 140);
    const prompt = String(json?.offer?.prompt || '').trim().slice(0, 220);
    if (note) return { note, offer: ask && prompt ? { ask, prompt } : null };
  } catch { /* fall through to plain text */ }
  return { note: text, offer: null };
}

module.exports = { describePhoto, buildPrompt, parseReply, MAX_BYTES };
