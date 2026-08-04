const assert = require('node:assert/strict');
const test = require('node:test');

const { getWavDurationMs, isImplausibleTranscript } = require('../../api/index');

// Minimal canonical WAV header: 24kHz, mono, 16-bit (byteRate 48000).
function wavWithDeclaredSize(declaredDataSize, actualDataBytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(24000, 24); // sampleRate
  header.writeUInt32LE(48000, 28); // byteRate
  header.write('data', 36);
  header.writeUInt32LE(declaredDataSize, 40);
  return Buffer.concat([header, Buffer.alloc(actualDataBytes)]);
}

test('getWavDurationMs reads duration from a well-formed header', () => {
  // 48000 bytes/sec, so 96000 bytes of audio is exactly 2s.
  assert.equal(getWavDurationMs(wavWithDeclaredSize(96000, 96000)), 2000);
});

// Streamed WAVs (OpenAI's TTS among them) are written before the length is known and carry
// the 0xFFFFFFFF "unknown size" placeholder. Read literally that is a ~24-hour clip, which
// drives words-per-second to ~0 and makes the hallucination guard below accept anything.
test('getWavDurationMs ignores the 0xFFFFFFFF streaming placeholder', () => {
  const buf = wavWithDeclaredSize(0xFFFFFFFF, 96000);
  assert.equal(getWavDurationMs(buf), 2000, 'must fall back to the bytes actually present');
});

test('getWavDurationMs clamps a declared size larger than the buffer', () => {
  assert.equal(getWavDurationMs(wavWithDeclaredSize(960000, 48000)), 1000);
});

test('getWavDurationMs returns null for buffers too short to hold a header', () => {
  assert.equal(getWavDurationMs(Buffer.alloc(10)), null);
});

// The guard's whole job is catching a transcript far longer than the audio could hold.
// With the placeholder duration it silently failed open on every streamed clip.
test('a placeholder-size WAV still lets the hallucination guard fire', () => {
  const buf = wavWithDeclaredSize(0xFFFFFFFF, 48000); // 1 second of audio
  const durationMs = getWavDurationMs(buf);
  const wordy = 'one two three four five six seven eight nine ten eleven twelve';
  assert.equal(isImplausibleTranscript(wordy, durationMs), true);
});
