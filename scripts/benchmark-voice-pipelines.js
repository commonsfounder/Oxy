#!/usr/bin/env node
const fs = require('fs');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');

function getArg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function printUsage() {
  console.log([
    'Usage:',
    '  npm run benchmark:voice -- --url https://your-service.run.app --user USER --password PASS --audio C:\\path\\sample.wav [--voice Aoede]',
    '',
    'What it measures:',
    '  - current /process-audio SSE pipeline',
    '  - prototype /companion-live WebSocket Gemini Live pipeline',
    '',
    'Outputs:',
    '  - first transcription latency',
    '  - first assistant text latency',
    '  - first assistant audio latency',
    '  - turn complete latency'
  ].join('\n'));
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printUsage();
  process.exit(0);
}

const baseUrl = getArg('url');
const userId = getArg('user');
const password = getArg('password');
const audioPath = getArg('audio');
const voice = getArg('voice', 'Aoede');

if (!baseUrl || !userId || !password || !audioPath) {
  printUsage();
  process.exit(1);
}

function toWsUrl(httpUrl, path) {
  const url = new URL(path, httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

async function login() {
  const response = await fetch(new URL('/auth/login', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, password })
  });

  if (!response.ok) {
    throw new Error(`Login failed with ${response.status}`);
  }

  const data = await response.json();
  if (!data.token) throw new Error('Login succeeded but no token returned.');
  return data.token;
}

async function runCurrentPipelineBenchmark(token, audioBuffer) {
  const form = new FormData();
  form.append('userId', userId);
  form.append('voice', voice);
  form.append('audio', new Blob([audioBuffer], { type: 'audio/wav' }), 'sample.wav');

  const start = performance.now();
  const timings = {
    firstTranscriptionMs: null,
    firstResponseMs: null,
    firstAudioMs: null,
    doneMs: null
  };

  const processAudioUrl = new URL('/process-audio?tts=true', baseUrl);
  const response = await fetch(processAudioUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });

  if (!response.ok || !response.body) {
    throw new Error(`Current pipeline failed with ${response.status}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  function record(event) {
    const elapsed = Math.round(performance.now() - start);
    if (event.type === 'transcription' && timings.firstTranscriptionMs == null) timings.firstTranscriptionMs = elapsed;
    if ((event.type === 'response' || event.type === 'text') && timings.firstResponseMs == null) timings.firstResponseMs = elapsed;
    if (event.type === 'audio' && timings.firstAudioMs == null) timings.firstAudioMs = elapsed;
    if (event.type === 'done' && timings.doneMs == null) timings.doneMs = elapsed;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const rawEvent of events) {
      const line = rawEvent.split('\n').find(item => item.startsWith('data: '));
      if (!line) continue;
      try {
        record(JSON.parse(line.slice(6)));
      } catch {}
    }
  }

  return timings;
}

function readWavAsMonoPcm(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Only RIFF/WAVE PCM files are supported for benchmarking.');
  }

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(chunkDataOffset),
        channels: buffer.readUInt16LE(chunkDataOffset + 2),
        sampleRate: buffer.readUInt32LE(chunkDataOffset + 4),
        bitsPerSample: buffer.readUInt16LE(chunkDataOffset + 14)
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!fmt || dataOffset < 0) throw new Error('WAV file is missing fmt or data chunk.');
  if (fmt.format !== 1 || fmt.bitsPerSample !== 16) throw new Error('Only 16-bit PCM WAV files are supported.');

  const source = buffer.subarray(dataOffset, dataOffset + dataSize);
  if (fmt.channels === 1) {
    return {
      sampleRate: fmt.sampleRate,
      pcmBytes: Buffer.from(source)
    };
  }

  const sourceSamples = new Int16Array(source.buffer, source.byteOffset, source.byteLength / 2);
  const monoSamples = new Int16Array(sourceSamples.length / fmt.channels);

  for (let i = 0, j = 0; i < sourceSamples.length; i += fmt.channels, j += 1) {
    let sum = 0;
    for (let channel = 0; channel < fmt.channels; channel += 1) sum += sourceSamples[i + channel];
    monoSamples[j] = Math.round(sum / fmt.channels);
  }

  return {
    sampleRate: fmt.sampleRate,
    pcmBytes: Buffer.from(monoSamples.buffer)
  };
}

async function runCompanionLiveBenchmark(token, audioBuffer) {
  const { sampleRate, pcmBytes } = readWavAsMonoPcm(audioBuffer);
  const wsUrl = toWsUrl(baseUrl, '/companion-live');

  const timings = {
    authenticatedMs: null,
    sessionReadyMs: null,
    firstUserTranscriptMs: null,
    firstAssistantTranscriptMs: null,
    firstAudioMs: null,
    turnCompleteMs: null
  };

  const start = performance.now();
  const chunkMs = 100;
  const bytesPerChunk = Math.max(3200, Math.floor(sampleRate * 2 * (chunkMs / 1000)));

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let streamPromise = null;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Companion live benchmark timed out after 60 seconds.'));
    }, 60000);

    function mark(field) {
      if (timings[field] == null) timings[field] = Math.round(performance.now() - start);
    }

    async function streamAudio() {
      for (let offset = 0; offset < pcmBytes.length; offset += bytesPerChunk) {
        const chunk = pcmBytes.subarray(offset, Math.min(offset + bytesPerChunk, pcmBytes.length));
        socket.send(JSON.stringify({
          type: 'audio.append',
          mimeType: `audio/l16;rate=${sampleRate}`,
          data: chunk.toString('base64')
        }));
        await new Promise(r => setTimeout(r, chunkMs));
      }
      socket.send(JSON.stringify({ type: 'audio.end' }));
    }

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'auth', token }));
    });

    socket.on('message', raw => {
      try {
        const event = JSON.parse(String(raw));
        if (event.type === 'session.authenticated') {
          mark('authenticatedMs');
          socket.send(JSON.stringify({ type: 'session.start', voice }));
        }
        if (event.type === 'session.ready') {
          mark('sessionReadyMs');
          if (!streamPromise) streamPromise = streamAudio().catch(reject);
        }
        if (event.type === 'transcript.user') mark('firstUserTranscriptMs');
        if (event.type === 'transcript.assistant') mark('firstAssistantTranscriptMs');
        if (event.type === 'audio') mark('firstAudioMs');
        if (event.type === 'turn.complete') {
          mark('turnCompleteMs');
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
        if (event.type === 'error') {
          clearTimeout(timeout);
          socket.close();
          reject(new Error(event.error || 'Companion live benchmark failed.'));
        }
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error);
      }
    });

    socket.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });

    socket.on('close', () => {
      clearTimeout(timeout);
    });
  });

  return timings;
}

function printComparison(currentTimings, liveTimings) {
  console.log('\nCurrent /process-audio pipeline');
  console.table([currentTimings]);

  console.log('\nPrototype /companion-live Gemini Live pipeline');
  console.table([liveTimings]);

  const summary = {
    currentFirstAudioMs: currentTimings.firstAudioMs,
    liveFirstAudioMs: liveTimings.firstAudioMs,
    improvementMs: currentTimings.firstAudioMs != null && liveTimings.firstAudioMs != null
      ? currentTimings.firstAudioMs - liveTimings.firstAudioMs
      : null,
    currentTurnCompleteMs: currentTimings.doneMs,
    liveTurnCompleteMs: liveTimings.turnCompleteMs,
    turnCompleteImprovementMs: currentTimings.doneMs != null && liveTimings.turnCompleteMs != null
      ? currentTimings.doneMs - liveTimings.turnCompleteMs
      : null
  };

  console.log('\nHigh-level comparison');
  console.table([summary]);
}

(async () => {
  try {
    const audioBuffer = fs.readFileSync(audioPath);
    const token = await login();
    const currentTimings = await runCurrentPipelineBenchmark(token, audioBuffer);
    const liveTimings = await runCompanionLiveBenchmark(token, audioBuffer);
    printComparison(currentTimings, liveTimings);
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
})();
