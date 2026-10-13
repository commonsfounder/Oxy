#!/usr/bin/env node

// Pair and exercise an Adam home device from a laptop. Every command talks to the real server the
// way the firmware does (firmware/adam-link), so the whole path can be proved before flashing.
//
//   1. In the app, start pairing a display; it shows a link (…/display?challenge=ID) and a code.
//   2. node scripts/home-device.js pair <link> <code> --name Kitchen      -> data/home-device.json
//   3. node scripts/home-device.js voice request.wav [--out reply.wav] [--stream]   (16 kHz mono 16-bit WAV;
//      --stream plays the reply as it is synthesised and reports time to first audio)
//      node scripts/home-device.js sound smoke_alarm [--confidence 0.95] [--sustained]
//   4. node scripts/home-device.js nvs --ssid HOME --password … > adam-nvs.csv
//      then: nvs_partition_gen.py generate adam-nvs.csv adam-nvs.bin 0x6000
//            parttool.py --port PORT write_partition --partition-name=nvs --input adam-nvs.bin
//
// The token is a credential: data/home-device.json is written 0600 and is gitignored (data/).

const fs = require('node:fs');
const path = require('node:path');

const STATE = process.env.ADAM_HOME_DEVICE_STATE || path.resolve(__dirname, '..', 'data', 'home-device.json');

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {
    throw new Error('Not paired yet. Run: node scripts/home-device.js pair <link> <code>');
  }
}

async function request(state, pathname, init) {
  const response = await fetch(`${state.baseUrl}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${state.token}`, ...(init.headers || {}) }
  });
  if (response.status === 401) throw new Error('The server refused this device token. Pair it again.');
  return response;
}

async function pair(args) {
  const [link, code] = args;
  if (!link || !code) throw new Error('Usage: pair <link from the app> <code> [--name Kitchen]');
  const url = new URL(link);
  const challengeId = url.searchParams.get('challenge');
  if (!challengeId) throw new Error('That link has no ?challenge= in it. Copy the whole pairing link from the app.');
  const response = await fetch(`${url.origin}/display/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, code, displayName: option(args, '--name', 'Adam device') })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Pairing failed (HTTP ${response.status}).`);
  const state = { baseUrl: url.origin, displayId: body.display.id, name: body.display.name, token: body.token };
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`Paired "${state.name}" (${state.displayId}) with ${state.baseUrl}. Saved to ${path.relative(process.cwd(), STATE)}.`);
}

async function voice(args) {
  const state = loadState();
  const file = args[0];
  if (!file) throw new Error('Usage: voice <request.wav> [--out reply.wav] [--stream]');
  const streamed = args.includes('--stream');
  const started = Date.now();
  const response = await request(state, `/display/${encodeURIComponent(state.displayId)}/voice${streamed ? '?stream=1' : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: fs.readFileSync(file)
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
  const headersAt = Date.now();
  let firstAudioAt = null;
  const parts = [];
  for await (const chunk of response.body) {
    if (firstAudioAt === null && chunk.length) firstAudioAt = Date.now();
    parts.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(parts);
  // A streamed reply is raw PCM; wrap it so it plays like the non-streamed WAV.
  const reply = streamed ? require('../api/services/device-audio').wavFromPcm16(body.subarray(0, body.length - (body.length % 2))) : body;
  const out = option(args, '--out', 'reply.wav');
  fs.writeFileSync(out, reply);
  const decode = name => decodeURIComponent(response.headers.get(name) || '');
  console.log(`Heard: ${decode('x-adam-heard')}`);
  console.log(`Adam (${response.headers.get('x-adam-reply-kind')}): ${decode('x-adam-reply')}`);
  console.log(`Words known after ${headersAt - started} ms; first audio after ${(firstAudioAt || Date.now()) - started} ms; done after ${Date.now() - started} ms`);
  console.log(`${reply.length} bytes of 16 kHz speech -> ${out}${streamed ? ' (streamed)' : ''}`);
}

async function sound(args) {
  const state = loadState();
  const key = args[0];
  if (!key) throw new Error('Usage: sound <key> [--confidence 0.95] [--sustained]');
  const response = await request(state, `/display/${encodeURIComponent(state.displayId)}/sounds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [{
      sound: key,
      kind: args.includes('--sustained') ? 'sustained' : 'heard',
      confidence: Number(option(args, '--confidence', '0.95')),
      occurredAt: new Date().toISOString()
    }] })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  console.log(JSON.stringify(body));
}

// NVS CSV for ESP-IDF's nvs_partition_gen.py. Keys match firmware/adam-link/esp-idf/adam_net.c.
function nvs(args) {
  const state = loadState();
  const ssid = option(args, '--ssid');
  const password = option(args, '--password', '');
  if (!ssid) throw new Error('Usage: nvs --ssid NAME --password PASS');
  const field = value => `"${String(value).replace(/"/g, '""')}"`;
  const rows = [
    'key,type,encoding,value',
    'adam,namespace,,',
    `base_url,data,string,${field(state.baseUrl)}`,
    `display_id,data,string,${field(state.displayId)}`,
    `token,data,string,${field(state.token)}`,
    `wifi_ssid,data,string,${field(ssid)}`,
    `wifi_pass,data,string,${field(password)}`
  ];
  process.stdout.write(`${rows.join('\n')}\n`);
}

const COMMANDS = { pair, voice, sound, nvs };

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) {
    console.error('Commands: pair, voice, sound, nvs. See the top of scripts/home-device.js.');
    process.exit(2);
  }
  Promise.resolve(run(args)).catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { COMMANDS };
