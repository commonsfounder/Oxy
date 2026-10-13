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

const pairedDisplays = require('../../api/services/paired-displays');
const DISPLAY = { id: 'disp-1', user_id: 'user-1', display_name: 'Kitchen' };
pairedDisplays.displayForToken = async (_supabase, id, token) => (id === DISPLAY.id && token === 'tok-1' ? DISPLAY : null);
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
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
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
