'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PhysicalRuntime } = require('./runtime');
const { PhysicalStore } = require('./store');
const { createAgent } = require('./agent');
const { sensorObservations, ingestSensors } = require('./box3-sensors');
process.env.OXY_TTS_TIMEOUT_MS ||= '35000';
const { transcribeSpeechOpenAI, synthesizeSpeechOpenAI } = require('../services/voice-provider');
const exec = promisify(execFile);
const CAPABILITIES = ['microphone', 'play_audio', 'display', 'audio.capture'];

async function voiceTurn({ input, output, resultPath, text, deviceId, sensorInput }) {
  const directory = path.resolve('data/box3');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const store = new PhysicalStore(path.join(directory, 'runtime.sqlite'));
  const runtime = new PhysicalRuntime({ store, agent: createAgent(), environment: 'development' });
  try {
    let message = text;
    let evidenceId = null;
    if (input || sensorInput) {
      if (!deviceId || !/^box3-[a-f0-9]{12}$/i.test(deviceId)) throw new Error('USB device identity required');
      const identityFile = path.join(directory, `${deviceId}.json`);
      let identity;
      try { identity = JSON.parse(await fs.readFile(identityFile, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        identity = runtime.registerDevice({ id: deviceId, hardwareType: 'ESP32-S3-BOX-3', adapter: 'usb-box3-v1', firmwareVersion: 'adam-box3-usb-v1', capabilities: CAPABILITIES });
        await fs.writeFile(identityFile, JSON.stringify(identity), { mode: 0o600 });
      }
      let device = runtime.authenticateDevice(deviceId, identity.secret);
      if (!device) throw new Error('Local USB identity does not match runtime registry');
      const snapshot = sensorInput ? JSON.parse(await fs.readFile(sensorInput, 'utf8')) : null;
      const capabilities = [...CAPABILITIES, ...(snapshot ? sensorObservations(snapshot).map(item => item.capability) : [])];
      runtime.announceCapabilities(deviceId, identity.secret, capabilities);
      runtime.heartbeat(deviceId, identity.secret, { recordingState: 'off' });
      device = runtime.authenticateDevice(deviceId, identity.secret);
      if (snapshot) ingestSensors(runtime, device, snapshot);
      if (input) {
        const wav = await fs.readFile(input);
        const capture = runtime.ingest({ type: 'audio.capture', value: { bytes: wav.length, sampleRate: 16000, captureMode: 'push_to_talk' }, source: { sensor: 'microphone' } }, { device });
        evidenceId = capture.observation.id;
        message = await transcribeSpeechOpenAI(wav);
        if (!message) throw new Error('No speech transcribed');
        runtime.ingest({ type: 'speech.transcription', value: { text: message, captureObservationId: evidenceId }, source: { adapter: 'openai-transcription' } }, { origin: 'external_service' });
      }
    }
    const turn = await runtime.chat(message);
    if (!turn.response) throw new Error('Adam returned no spoken response');
    const audio = Buffer.from(await synthesizeSpeechOpenAI(turn.response), 'base64');
    const temporary = `${output}.source.wav`;
    try {
      await fs.writeFile(temporary, audio, { mode: 0o600 });
      await exec('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', temporary, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], { timeout: 20_000 });
    } finally { await fs.rm(temporary, { force: true }); }
    const result = { heard: message, response: turn.response, decision: turn.decision, conversationId: turn.id, captureObservationId: evidenceId };
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  } finally { store.close(); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  voiceTurn({ input: option('--input'), output: option('--output'), resultPath: option('--result'), text: option('--text'), deviceId: option('--device'), sensorInput: option('--sensor-input') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { voiceTurn };
