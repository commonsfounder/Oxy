'use strict';
/*
 * Voice provider seam — speech out (TTS) and speech in (transcription).
 *
 * Split from the chat brain deliberately: voice is a different transport (raw audio in,
 * audio bytes out) and a different product decision (the assistant's voice identity), so
 * it gets its own switch rather than riding on OXY_BRAIN_PROVIDER.
 *
 *   OXY_VOICE_PROVIDER   = openai (default) | gemini
 *   OXY_TTS_MODEL        = gpt-4o-mini-tts (default)
 *   OXY_TTS_VOICE        = OpenAI voice id; overrides the mapping below outright
 *   OXY_TRANSCRIBE_MODEL = gpt-4o-transcribe (default)
 *
 * Callers get base64 WAV either way, so the SSE audio events and the iOS client are
 * unchanged. OpenAI can return WAV directly, so unlike the Gemini path (raw PCM needing a
 * synthesised RIFF header) there is no conversion step here.
 */

const OPENAI_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'
]);

// The default was Gemini's 'Aoede' — warm, female, unhurried. 'coral' is the closest
// OpenAI equivalent in warmth and register, so a user who never touched the setting hears
// roughly the same character of voice rather than an abrupt swap to a brighter or flatter
// one. Saved settings still hold Gemini names, so map the ones users could actually pick
// instead of dropping every stored preference to the default.
const DEFAULT_OPENAI_VOICE = 'coral';
const GEMINI_TO_OPENAI_VOICE = {
  Aoede: 'coral',
  Kore: 'shimmer',
  Leda: 'nova',
  Callirrhoe: 'sage',
  Autonoe: 'alloy',
  Despina: 'ballad',
  Erinome: 'shimmer',
  Laomedeia: 'nova',
  Puck: 'fable',
  Charon: 'onyx',
  Fenrir: 'ash',
  Orus: 'echo',
  Zephyr: 'verse',
  Iapetus: 'echo',
  Enceladus: 'onyx',
  Umbriel: 'ash'
};

function getVoiceProvider() {
  return (process.env.OXY_VOICE_PROVIDER || 'openai').toLowerCase();
}

// Accepts an OpenAI voice id, a legacy Gemini voice name, or nothing at all.
function resolveOpenAIVoice(voiceName) {
  const envVoice = process.env.OXY_TTS_VOICE;
  if (envVoice && OPENAI_VOICES.has(envVoice)) return envVoice;
  const raw = String(voiceName || '').trim();
  if (OPENAI_VOICES.has(raw.toLowerCase())) return raw.toLowerCase();
  return GEMINI_TO_OPENAI_VOICE[raw] || DEFAULT_OPENAI_VOICE;
}

function openAIKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set (needed for OXY_VOICE_PROVIDER=openai)');
  return apiKey;
}

function openAIBaseURL() {
  return process.env.OXY_VOICE_BASE_URL || 'https://api.openai.com/v1';
}

const TTS_TIMEOUT_MS = Number(process.env.OXY_TTS_TIMEOUT_MS || 9000);

/*
 * Returns base64-encoded WAV, or null for empty input.
 * Throws on provider failure so the caller's existing catch decides whether a turn
 * degrades to text-only — this layer never silently returns no audio.
 */
async function synthesizeSpeechOpenAI(text, voiceName) {
  const voice = resolveOpenAIVoice(voiceName);
  const model = process.env.OXY_TTS_MODEL || 'gpt-4o-mini-tts';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
    const res = await fetch(`${openAIBaseURL()}/audio/speech`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAIKey()}` },
      body: JSON.stringify({ model, voice, input: text, response_format: 'wav' })
    });
    if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error(`OpenAI TTS returned empty audio for voice ${voice}.`);
    console.log(`[tts] openai voice=${voice} model=${model} bytes=${buf.length}`);
    return buf.toString('base64');
  } finally {
    clearTimeout(timeoutId);
  }
}

/*
 * Transcribes WAV audio to text.
 *
 * Sent as multipart/form-data, which is what the endpoint takes — the JSON+inlineData
 * shape the Gemini path used has no equivalent here.
 */
async function transcribeSpeechOpenAI(buffer, mimeType = 'audio/wav') {
  const model = process.env.OXY_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), 'audio.wav');
  form.append('model', model);
  // Transcription only. Without this the model will happily "help" by answering the
  // question it heard, which then gets treated downstream as the user's own words.
  form.append('prompt', 'Transcribe verbatim. Do not answer or interpret the speech.');

  const res = await fetch(`${openAIBaseURL()}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openAIKey()}` },
    body: form
  });
  if (!res.ok) throw new Error(`OpenAI transcribe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return String(json.text || '').trim();
}

module.exports = {
  getVoiceProvider,
  resolveOpenAIVoice,
  synthesizeSpeechOpenAI,
  transcribeSpeechOpenAI,
  OPENAI_VOICES,
  DEFAULT_OPENAI_VOICE,
  GEMINI_TO_OPENAI_VOICE
};
