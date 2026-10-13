'use strict';

// WAV in and out for small devices. A device sends 16 kHz mono 16-bit PCM and plays the same
// format back, so it never has to decode, resample or parse anything but a fixed header.
// Speech synthesis returns 24 kHz WAV; this resamples it here instead of shipping ffmpeg in the
// server image.

const DEVICE_SAMPLE_RATE = 16000;
const MAX_CAPTURE_SECONDS = 15;
const MIN_CAPTURE_SECONDS = 0.3;

function audioError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Reads a PCM WAV: walks the chunks rather than assuming a 44-byte header, because encoders add
// LIST/fact chunks and some write a data size of 0 or 0xFFFFFFFF when they stream.
function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw audioError('invalid_audio', 'Audio is not a WAV file.');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw audioError('invalid_audio', 'Audio is not a WAV file.');
  }
  let format = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buffer.length) throw audioError('invalid_audio', 'WAV format chunk is truncated.');
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      if (!format) throw audioError('invalid_audio', 'WAV data came before its format.');
      const end = size === 0 || size === 0xFFFFFFFF || body + size > buffer.length ? buffer.length : body + size;
      const usable = end - body - ((end - body) % 2);
      return { ...format, pcm: buffer.subarray(body, body + usable) };
    }
    offset = body + size + (size % 2);
  }
  throw audioError('invalid_audio', 'WAV has no audio data.');
}

function wavFromPcm16(pcm, sampleRate = DEVICE_SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// What a device is allowed to send: exactly the format its firmware records.
function validateDeviceCapture(buffer) {
  const wav = parseWav(buffer);
  if (wav.audioFormat !== 1 || wav.bitsPerSample !== 16 || wav.channels !== 1 || wav.sampleRate !== DEVICE_SAMPLE_RATE) {
    throw audioError('unsupported_audio', 'Send 16 kHz mono 16-bit PCM WAV.');
  }
  const seconds = wav.pcm.length / 2 / DEVICE_SAMPLE_RATE;
  if (seconds < MIN_CAPTURE_SECONDS) throw audioError('too_short', 'That recording is too short.');
  if (seconds > MAX_CAPTURE_SECONDS) throw audioError('too_long', `Keep a request under ${MAX_CAPTURE_SECONDS} seconds.`);
  return { seconds, wav: buffer };
}

function readMono(wav) {
  const frames = Math.floor(wav.pcm.length / 2 / wav.channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < wav.channels; c++) sum += wav.pcm.readInt16LE((i * wav.channels + c) * 2);
    out[i] = sum / wav.channels;
  }
  return out;
}

// Resampling with a short windowed-sinc low-pass, so 24 kHz speech doesn't alias when it is
// squeezed under the 8 kHz Nyquist limit of the device's output.
function resample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const cutoff = Math.min(1, to / from) * 0.95;
  const half = 16;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const center = i * ratio;
    const start = Math.floor(center) - half + 1;
    let acc = 0;
    let weight = 0;
    for (let j = start; j < start + 2 * half; j++) {
      if (j < 0 || j >= samples.length) continue;
      const x = j - center;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const window = 0.5 + 0.5 * Math.cos(Math.PI * x / half);
      const w = sinc * window;
      acc += samples[j] * w;
      weight += w;
    }
    out[i] = weight ? acc / weight : 0;
  }
  return out;
}

// The same filter as resample(), fed in pieces: push() raw little-endian 16-bit mono chunks of any
// size (odd byte counts included) and get back 16-bit samples at the new rate as soon as each one's
// whole filter window has arrived; flush() finishes the tail. Output is identical to resample() over
// the whole signal, so a streamed reply sounds exactly like a downloaded one.
function createStreamingResampler(from, to = DEVICE_SAMPLE_RATE) {
  const ratio = from / to;
  const cutoff = Math.min(1, to / from) * 0.95;
  const half = 16;
  let buffer = new Float32Array(0);
  let base = 0;        // absolute index of buffer[0]
  let received = 0;    // samples received so far
  let next = 0;        // next output index
  let carry = null;    // a dangling byte from an odd-sized chunk

  function value(i, limit) {
    const center = i * ratio;
    const start = Math.floor(center) - half + 1;
    let acc = 0;
    let weight = 0;
    for (let j = start; j < start + 2 * half; j++) {
      if (j < 0 || j >= limit) continue;
      const x = j - center;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const w = sinc * (0.5 + 0.5 * Math.cos(Math.PI * x / half));
      acc += buffer[j - base] * w;
      weight += w;
    }
    return weight ? acc / weight : 0;
  }

  function emit(limit, ready) {
    const out = [];
    while (ready(next)) out.push(value(next++, limit));
    const keepFrom = Math.max(base, Math.floor(next * ratio) - half + 1);
    if (keepFrom > base) {
      buffer = buffer.slice(keepFrom - base);
      base = keepFrom;
    }
    const pcm = Buffer.alloc(out.length * 2);
    // Math.fround: resample() keeps samples in a Float32Array, so round from the same 32-bit value.
    out.forEach((sample, k) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(Math.fround(sample)))), k * 2));
    return pcm;
  }

  return {
    push(chunk) {
      let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (carry) { bytes = Buffer.concat([carry, bytes]); carry = null; }
      if (bytes.length % 2) { carry = bytes.subarray(bytes.length - 1); bytes = bytes.subarray(0, bytes.length - 1); }
      const count = bytes.length / 2;
      const grown = new Float32Array(buffer.length + count);
      grown.set(buffer);
      for (let k = 0; k < count; k++) grown[buffer.length + k] = bytes.readInt16LE(k * 2);
      buffer = grown;
      received += count;
      return emit(Infinity, i => Math.floor(i * ratio) + half < received);
    },
    flush() {
      const total = received;
      const length = Math.floor(total / ratio);
      return emit(total, i => i < length);
    }
  };
}

// Any PCM WAV from speech synthesis -> the device's playback format.
function toDeviceWav(buffer) {
  const wav = parseWav(buffer);
  if (wav.audioFormat !== 1 || wav.bitsPerSample !== 16 || wav.channels < 1) {
    throw audioError('unsupported_audio', 'Speech audio must be 16-bit PCM.');
  }
  const samples = resample(readMono(wav), wav.sampleRate, DEVICE_SAMPLE_RATE);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), i * 2);
  }
  return wavFromPcm16(pcm, DEVICE_SAMPLE_RATE);
}

module.exports = {
  DEVICE_SAMPLE_RATE,
  MAX_CAPTURE_SECONDS,
  createStreamingResampler,
  parseWav,
  toDeviceWav,
  validateDeviceCapture,
  wavFromPcm16
};
