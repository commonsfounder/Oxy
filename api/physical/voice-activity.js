'use strict';

function wavData(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV');
  let offset = 12;
  let format = null;
  let samples = null;
  while (offset + 8 <= buffer.length) {
    const name = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > buffer.length) throw new Error('Invalid WAV chunk');
    if (name === 'fmt ') format = { encoding: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), bits: buffer.readUInt16LE(start + 14) };
    if (name === 'data') samples = buffer.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (!format || !samples || format.encoding !== 1 || format.channels !== 1 || format.bits !== 16) throw new Error('Expected mono 16-bit PCM WAV');
  return { ...format, samples };
}

function detectSpeechWindow(buffer, { frameMs = 20, minSpeechMs = 200, threshold = 0.018, paddingMs = 150 } = {}) {
  const { sampleRate, samples } = wavData(buffer);
  const sampleCount = Math.floor(samples.length / 2);
  const samplesPerFrame = Math.max(1, Math.round(sampleRate * frameMs / 1000));
  const active = [];
  for (let start = 0; start < sampleCount; start += samplesPerFrame) {
    let power = 0;
    const end = Math.min(sampleCount, start + samplesPerFrame);
    for (let i = start; i < end; i++) {
      const sample = samples.readInt16LE(i * 2) / 32768;
      power += sample * sample;
    }
    active.push(Math.sqrt(power / (end - start)) >= threshold);
  }
  const needed = Math.max(1, Math.ceil(minSpeechMs / frameMs));
  let first = -1;
  let run = 0;
  for (let i = 0; i < active.length; i++) {
    run = active[i] ? run + 1 : 0;
    if (run >= needed) { first = i - run + 1; break; }
  }
  if (first < 0) return null;
  let last = active.length - 1;
  while (last > first && !active[last]) last--;
  return {
    startSeconds: Math.max(0, first * frameMs / 1000 - paddingMs / 1000),
    endSeconds: Math.min(sampleCount / sampleRate, (last + 1) * frameMs / 1000 + paddingMs / 1000)
  };
}

module.exports = { detectSpeechWindow, wavData };
