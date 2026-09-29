'use strict';

require('dotenv').config();
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { transcribeSpeechOpenAI } = require('../services/voice-provider');
const { detectSpeechWindow } = require('./voice-activity');

const exec = promisify(execFile);
async function main() {
  const args = process.argv.slice(2);
  const listen = args.includes('--listen');
  const speak = args.includes('--speak');
  const roomIndex = args.indexOf('--room');
  const microphoneIndex = args.indexOf('--mic-index');
  const roomId = roomIndex >= 0 ? args[roomIndex + 1] : null;
  const deviceIndex = microphoneIndex >= 0 ? args[microphoneIndex + 1] : '0';
  if (!/^\d+$/.test(deviceIndex || '')) throw new Error('Microphone index must be a number');
  let message = args.filter((value, index) => !['--listen', '--speak'].includes(value) && index !== roomIndex && index !== roomIndex + 1 && index !== microphoneIndex && index !== microphoneIndex + 1).join(' ').trim();
  if (listen) {
    const filename = path.join(os.tmpdir(), `adam-voice-${process.pid}.wav`);
    const trimmed = path.join(os.tmpdir(), `adam-voice-trimmed-${process.pid}.wav`);
    try {
      await exec('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-i', `:${deviceIndex}`, '-t', '8', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', filename], { timeout: 15_000 });
      const window = detectSpeechWindow(await fs.readFile(filename));
      if (!window) throw new Error('No speech activity detected');
      await exec('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-ss', String(window.startSeconds), '-to', String(window.endSeconds), '-i', filename, '-c:a', 'pcm_s16le', trimmed], { timeout: 10_000 });
      message = await transcribeSpeechOpenAI(await fs.readFile(trimmed));
    } finally { await fs.rm(filename, { force: true }); await fs.rm(trimmed, { force: true }); }
  }
  if (!message) throw new Error('Give text or use --listen');
  const response = await fetch(`http://127.0.0.1:${process.env.ADAM_PORT || 4317}/v1/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.ADAM_ADMIN_TOKEN ? { 'x-adam-admin-token': process.env.ADAM_ADMIN_TOKEN } : {}) },
    body: JSON.stringify({ message, roomId })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  console.log(JSON.stringify({ heard: message, response: result.response, decision: result.decision, result: result.result }, null, 2));
  if (speak && result.response) await exec('/usr/bin/say', [result.response], { timeout: 30_000 });
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
