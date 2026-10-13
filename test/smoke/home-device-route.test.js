// The home-device routes end to end through the real Express app and the real pairing script.
// Only the outside world is replaced: OpenAI speech, the database, and the /chat turn itself.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { wavFromPcm16, parseWav } = require('../../api/services/device-audio');

function tone(hz, seconds, rate) {
  const pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * hz * i / rate)), i * 2);
  return wavFromPcm16(pcm, rate);
}

const chatRequests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  if (url.startsWith(process.env.SUPABASE_URL)) {
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (/^http:\/\/127\.0\.0\.1:\d+\/chat$/.test(url)) {
    chatRequests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ text: 'You have the **dentist** at 9.', actions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(input, init);
};

const voiceProvider = require('../../api/services/voice-provider');
const heardBy = [];
voiceProvider.transcribeSpeechOpenAI = async wav => { heardBy.push(parseWav(wav).sampleRate); return 'what is on tomorrow'; };
voiceProvider.synthesizeSpeechOpenAI = async () => tone(220, 0.6, 24000).toString('base64');
// Streamed speech: the same tone as raw 24 kHz PCM, in awkward odd-sized pieces with gaps between them.
voiceProvider.streamSpeechOpenAI = async function* () {
  const pcm = parseWav(tone(220, 0.6, 24000)).pcm;
  for (let offset = 0; offset < pcm.length; offset += 1001) {
    await new Promise(resolve => setTimeout(resolve, 5));
    yield pcm.subarray(offset, offset + 1001);
  }
};

const pairedDisplays = require('../../api/services/paired-displays');
const DISPLAY = { id: 'disp-1', user_id: 'user-1', display_name: 'Kitchen' };
pairedDisplays.displayForToken = async (_supabase, id, token) => (id === DISPLAY.id && token === 'tok-1' ? DISPLAY : null);
const seen = [];
pairedDisplays.markSeen = async (_supabase, id) => { seen.push(id); };
pairedDisplays.redeemPairingChallenge = async (_supabase, body) => {
  if (body.challengeId !== 'chal-1' || body.code !== 'ABC123') {
    const error = new Error('That pairing code is not correct.');
    error.code = 'invalid_pairing';
    throw error;
  }
  return { display: { id: DISPLAY.id, name: body.displayName }, token: 'tok-1' };
};

const app = require('../../api/index');
const run = promisify(execFile);

test('pair, speak and report a sound with the same calls the firmware makes', async () => {
  const server = app.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adam-device-'));
  const env = { ...process.env, ADAM_HOME_DEVICE_STATE: path.join(dir, 'state.json') };
  const script = path.resolve(__dirname, '../../scripts/home-device.js');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const paired = await run('node', [script, 'pair', `${base}/display?challenge=chal-1`, 'ABC123', '--name', 'Kitchen'], { env });
    assert.match(paired.stdout, /Paired "Kitchen" \(disp-1\)/);
    assert.equal((fs.statSync(env.ADAM_HOME_DEVICE_STATE).mode & 0o777), 0o600);

    fs.writeFileSync(path.join(dir, 'ask.wav'), tone(300, 1.2, 16000));
    const spoken = await run('node', [script, 'voice', path.join(dir, 'ask.wav'), '--out', path.join(dir, 'reply.wav')], { env });
    assert.match(spoken.stdout, /Heard: what is on tomorrow/);
    assert.match(spoken.stdout, /Adam \(answer\): You have the dentist at 9\./);
    const reply = parseWav(fs.readFileSync(path.join(dir, 'reply.wav')));
    assert.equal(reply.sampleRate, 16000);
    assert.ok(reply.pcm.length > 16000);
    assert.deepEqual(heardBy, [16000]);
    assert.deepEqual(chatRequests.map(r => [r.userId, r.message, r.channel]), [['user-1', 'what is on tomorrow', 'home_device']]);

    const reported = await run('node', [script, 'sound', 'smoke_alarm'], { env });
    assert.deepEqual({ ...JSON.parse(reported.stdout), raised: 0 }, { received: 1, raised: 0, ignored: [] });

    const unknown = JSON.parse((await run('node', [script, 'sound', 'unicorn'], { env })).stdout);
    assert.equal(unknown.received, 0);
    assert.equal(unknown.ignored[0].reason, 'unknown_sound');

    const csv = (await run('node', [script, 'nvs', '--ssid', 'Home "5G"', '--password', 'pw'], { env })).stdout;
    assert.match(csv, /^key,type,encoding,value\nadam,namespace,,\n/);
    assert.match(csv, /token,data,string,"tok-1"/);
    assert.match(csv, /wifi_ssid,data,string,"Home ""5G"""/);

    // Self-pairing box: Wi-Fi and the server only, no laptop pairing needed.
    const fresh = (await run('node', [script, 'nvs', '--ssid', 'Home', '--password', 'pw', '--server', 'https://adam.example/'],
      { env: { ...process.env, ADAM_HOME_DEVICE_STATE: path.join(dir, 'none.json') } })).stdout;
    assert.match(fresh, /base_url,data,string,"https:\/\/adam\.example"\n/);
    assert.doesNotMatch(fresh, /token|display_id/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a streamed reply arrives as raw 16 kHz PCM, identical to the downloaded one, and the script reports first audio', async () => {
  const server = app.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adam-device-'));
  const env = { ...process.env, ADAM_HOME_DEVICE_STATE: path.join(dir, 'state.json') };
  const script = path.resolve(__dirname, '../../scripts/home-device.js');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    fs.writeFileSync(env.ADAM_HOME_DEVICE_STATE, JSON.stringify({ baseUrl: base, displayId: 'disp-1', token: 'tok-1' }));
    fs.writeFileSync(path.join(dir, 'ask.wav'), tone(300, 1.2, 16000));
    const resetRate = () => require('../../api/services/display-ask')._reset(); // one turn per 3 s per device

    resetRate();
    const raw = await fetch(`${base}/display/disp-1/voice?stream=1`, {
      method: 'POST', headers: { Authorization: 'Bearer tok-1', 'Content-Type': 'audio/wav' }, body: fs.readFileSync(path.join(dir, 'ask.wav'))
    });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('content-type'), 'audio/L16; rate=16000; channels=1');
    assert.equal(decodeURIComponent(raw.headers.get('x-adam-reply')), 'You have the dentist at 9.');
    const streamedPcm = Buffer.from(await raw.arrayBuffer());
    const { toDeviceWav } = require('../../api/services/device-audio');
    assert.ok(streamedPcm.equals(parseWav(toDeviceWav(tone(220, 0.6, 24000))).pcm), 'streamed audio matches the non-streamed reply sample for sample');

    resetRate();
    const run = await promisify(execFile)('node', [script, 'voice', path.join(dir, 'ask.wav'), '--stream', '--out', path.join(dir, 'reply.wav')], { env });
    assert.match(run.stdout, /Words known after \d+ ms; first audio after \d+ ms; done after \d+ ms/);
    assert.match(run.stdout, /\(streamed\)/);
    const saved = parseWav(fs.readFileSync(path.join(dir, 'reply.wav')));
    assert.equal(saved.sampleRate, 16000);
    assert.ok(saved.pcm.equals(streamedPcm));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a device is seen whenever it speaks, reports a sound or sends its heartbeat; a bad token is not', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, token, body = '{}', type = 'application/json') => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': type, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body
  });
  try {
    seen.length = 0;
    const ok = await post('/display/disp-1/heartbeat', 'tok-1');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, heartbeatSeconds: 60 });
    assert.deepEqual(seen, ['disp-1']);

    assert.equal((await post('/display/disp-1/heartbeat', 'wrong')).status, 401);
    assert.equal((await post('/display/disp-1/heartbeat')).status, 401);
    assert.deepEqual(seen, ['disp-1'], 'a refused request never marks the device seen');

    await post('/display/disp-1/sounds', 'tok-1', JSON.stringify({ events: [{ sound: 'knock', confidence: 0.9, occurredAt: new Date().toISOString() }] }));
    require('../../api/services/display-ask')._reset();
    await post('/display/disp-1/voice', 'tok-1', tone(300, 1, 16000), 'audio/wav');
    assert.deepEqual(seen, ['disp-1', 'disp-1', 'disp-1']);
  } finally {
    server.close();
  }
});

test('a wrong pairing code and a refused token are reported plainly', async () => {
  const server = app.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adam-device-'));
  const env = { ...process.env, ADAM_HOME_DEVICE_STATE: path.join(dir, 'state.json') };
  const script = path.resolve(__dirname, '../../scripts/home-device.js');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(run('node', [script, 'pair', `${base}/display?challenge=chal-1`, 'WRONG1'], { env }),
      error => /invalid or expired/.test(error.stderr));
    fs.writeFileSync(env.ADAM_HOME_DEVICE_STATE, JSON.stringify({ baseUrl: base, displayId: 'disp-1', token: 'stolen' }));
    await assert.rejects(run('node', [script, 'sound', 'knock'], { env }), error => /Pair it again/.test(error.stderr));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
