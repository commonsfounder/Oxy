const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const { parseWav, toDeviceWav, validateDeviceCapture, wavFromPcm16 } = require('../../api/services/device-audio');
const { deviceSoundEvents, SOUNDS } = require('../../api/services/device-sounds');
const { deviceVoiceTurn, deviceVoiceTurnStream, spokenText, SAY } = require('../../api/services/device-voice');
const { buildChatChannelContext, buildHomeDeviceChatRequest } = require('../../api/services/chat-channel');

function tone(hz, seconds, rate, amplitude = 8000) {
  const pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * hz * i / rate)), i * 2);
  return wavFromPcm16(pcm, rate);
}

function zeroCrossingHz(wav) {
  const { pcm, sampleRate } = parseWav(wav);
  let crossings = 0;
  for (let i = 2; i < pcm.length; i += 2) {
    if ((pcm.readInt16LE(i - 2) < 0) !== (pcm.readInt16LE(i) < 0)) crossings++;
  }
  return crossings / 2 / (pcm.length / 2 / sampleRate);
}

function rms(wav) {
  const { pcm } = parseWav(wav);
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
}

// --- audio ---------------------------------------------------------------------------------

test('a device recording must be the format the firmware records: 16 kHz mono 16-bit, 0.3–15 s', () => {
  assert.equal(validateDeviceCapture(tone(440, 2, 16000)).seconds, 2);
  assert.throws(() => validateDeviceCapture(tone(440, 2, 24000)), { code: 'unsupported_audio' });
  assert.throws(() => validateDeviceCapture(tone(440, 0.1, 16000)), { code: 'too_short' });
  assert.throws(() => validateDeviceCapture(tone(440, 16, 16000)), { code: 'too_long' });
  assert.throws(() => validateDeviceCapture(Buffer.from('not audio at all')), { code: 'invalid_audio' });
});

test('WAV chunks are walked, so extra chunks and a streamed data size still parse', () => {
  const plain = tone(440, 0.5, 16000);
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]);
  const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
  withList.writeUInt32LE(0xFFFFFFFF, 36 + list.length + 4);
  const parsed = parseWav(withList);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.pcm.length, plain.length - 44);
});

test('speech audio is resampled to 16 kHz without changing its pitch', () => {
  const out = toDeviceWav(tone(440, 1, 24000));
  const parsed = parseWav(out);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.ok(Math.abs(parsed.pcm.length / 2 - 16000) <= 2);
  assert.ok(Math.abs(zeroCrossingHz(out) - 440) < 5, `pitch ${zeroCrossingHz(out)}`);
  assert.ok(rms(out) > 0.9 * rms(tone(440, 1, 24000)));
});

test('sound above the device\'s 8 kHz limit is filtered out rather than folded back as noise', () => {
  const out = toDeviceWav(tone(10000, 1, 24000));
  assert.ok(rms(out) < 0.1 * rms(tone(10000, 1, 24000)), `aliased energy ${rms(out)}`);
});

// --- sounds --------------------------------------------------------------------------------

const NOW = new Date('2026-10-13T10:00:00Z');

test('a device sends keys and scores; the wording and id come from the server, matching the phone', () => {
  const { events, ignored } = deviceSoundEvents([
    { sound: 'smoke_alarm', confidence: 0.95, occurredAt: '2026-10-13T09:59:30Z', title: 'Injected text' },
    { sound: 'doorbell', confidence: 0.9, occurredAt: '2026-10-13T09:59:00Z' }
  ], { now: NOW, room: 'Kitchen' });
  assert.deepEqual(ignored, []);
  assert.equal(events[0].title, 'Smoke alarm heard');
  assert.equal(events[0].body, 'A smoke alarm is sounding nearby.');
  assert.equal(events[0].urgent, true);
  assert.equal(events[0].room, 'Kitchen');
  const bucket = Math.floor(Date.parse('2026-10-13T09:59:30Z') / 1000 / 900);
  assert.equal(events[0].id, `sound:smoke_alarm:${bucket}`);
  assert.equal(events[1].id.startsWith('sound:door_bell:'), true);
});

test('sounds the model can\'t yet catch reliably are accepted but kept from interrupting anyone', () => {
  const { decideIntervention } = require('../../api/services/household-events');
  const { events } = deviceSoundEvents([{ sound: 'scream', confidence: 0.99, occurredAt: NOW.toISOString() }], { now: NOW });
  assert.equal(SOUNDS.scream.surface, false);
  assert.equal(decideIntervention({ event: events[0], now: NOW }).surface, false);
  const glass = deviceSoundEvents([{ sound: 'glass_breaking', confidence: 0.92, occurredAt: NOW.toISOString() }], { now: NOW }).events[0];
  assert.equal(decideIntervention({ event: glass, now: NOW }).surface, true);
});

test('unknown, stale, future or malformed sounds are ignored with a reason', () => {
  const { events, ignored } = deviceSoundEvents([
    { sound: 'unicorn', confidence: 0.9, occurredAt: NOW.toISOString() },
    { sound: 'knock', confidence: 0.9, occurredAt: '2026-10-13T09:00:00Z' },
    { sound: 'knock', confidence: 0.9, occurredAt: '2026-10-13T11:00:00Z' },
    { sound: 'knock', confidence: 2, occurredAt: NOW.toISOString() },
    { sound: 'water_running', confidence: 0.99, occurredAt: NOW.toISOString() }
  ], { now: NOW });
  assert.equal(events.length, 0);
  assert.deepEqual(ignored.map(i => i.reason), ['unknown_sound', 'too_old', 'invalid_time', 'invalid_confidence', 'not_yet_sustained']);
  assert.throws(() => deviceSoundEvents([], { now: NOW }), { code: 'invalid_sounds' });
});

// --- voice turn ----------------------------------------------------------------------------

function fakes({ heard = 'what is on tomorrow', result = { text: 'You have a dentist at 9.' } } = {}) {
  const calls = { asked: [], spoken: [] };
  return {
    calls,
    transcribe: async () => heard,
    ask: async text => { calls.asked.push(text); if (result instanceof Error) throw result; return result; },
    synthesize: async text => { calls.spoken.push(text); return tone(220, 0.5, 24000); }
  };
}

test('a spoken request runs as the user and comes back as 16 kHz speech', async () => {
  const f = fakes();
  const turn = await deviceVoiceTurn({ audio: tone(300, 1.5, 16000), ...f });
  assert.deepEqual(f.calls.asked, ['what is on tomorrow']);
  assert.equal(turn.reply, 'You have a dentist at 9.');
  assert.equal(turn.kind, 'answer');
  assert.equal(parseWav(turn.audio).sampleRate, 16000);
});

test('a shared device can\'t approve: "yes do it" is refused before it reaches Adam', async () => {
  const f = fakes({ heard: 'yes, do it' });
  const turn = await deviceVoiceTurn({ audio: tone(300, 1, 16000), ...f });
  assert.deepEqual(f.calls.asked, []);
  assert.equal(turn.reply, SAY.approveOnPhone);
});

test('a request that ends waiting for approval says it is on the phone', async () => {
  const f = fakes({ result: { text: 'Pay £48.75 to John Lewis?', actions: [{ result: { pending: true } }] } });
  const turn = await deviceVoiceTurn({ audio: tone(300, 1, 16000), ...f });
  assert.equal(turn.reply, SAY.waitingOnPhone);
  assert.equal(turn.kind, 'approval');
  assert.equal(f.calls.spoken[0].includes('48.75'), false);
});

test('silence, a failed turn and a quiet reply each get a short spoken answer', async () => {
  assert.equal((await deviceVoiceTurn({ audio: tone(300, 1, 16000), ...fakes({ heard: '  ' }) })).reply, SAY.notHeard);
  assert.equal((await deviceVoiceTurn({ audio: tone(300, 1, 16000), ...fakes({ result: new Error('boom') }) })).reply, SAY.failed);
  assert.equal((await deviceVoiceTurn({ audio: tone(300, 1, 16000), ...fakes({ result: { text: require('../../api/services/reactions').QUIET_REPLY } }) })).kind, 'answer');
});

test('replies are made speakable: no markdown or links, and long answers end pointing to the phone', () => {
  assert.equal(spokenText('**Two** things:\n- [Tesco](https://tesco.com) at 6\n- gym'), 'Two things: Tesco at 6 gym');
  const long = spokenText('This is a sentence that goes on. '.repeat(40));
  assert.ok(long.length < 660);
  assert.match(long, /The rest is on your phone\.$/);
});

test('the home-device channel tells Adam its reply is spoken in a shared room', () => {
  assert.deepEqual(buildHomeDeviceChatRequest('u1', 'hi'), { userId: 'u1', message: 'hi', channel: 'home_device' });
  assert.match(buildChatChannelContext('home_device'), /read aloud/);
  assert.match(buildChatChannelContext('home_device'), /approved on the phone/);
});

// --- routes --------------------------------------------------------------------------------

test('device voice and sound routes refuse a request without the device token', async () => {
  const app = require('../../api/index');
  const server = app.listen(0);
  const post = (path, body, type) => new Promise((resolve, reject) => {
    const req = http.request({ method: 'POST', hostname: '127.0.0.1', port: server.address().port, path, headers: { 'Content-Type': type } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
  try {
    assert.equal(await post('/display/d1/voice', tone(300, 1, 16000), 'audio/wav'), 401);
    assert.equal(await post('/display/d1/sounds', JSON.stringify({ events: [] }), 'application/json'), 401);
  } finally {
    server.close();
  }
});

test('a streamed turn announces the words before any audio, and approval words never reach Adam', async () => {
  const events = [];
  const pcm24 = parseWav(tone(220, 0.5, 24000)).pcm;
  const streamSpeech = async function* (text) { events.push(['speak', text]); yield pcm24.subarray(0, 333); yield pcm24.subarray(333); };
  const sent = await deviceVoiceTurnStream({
    audio: tone(300, 1, 16000), transcribe: async () => 'what is on tomorrow', ask: async () => ({ text: 'Dentist at 9.' }),
    streamSpeech, onStart: info => events.push(['start', info.reply, info.kind]), onAudio: pcm => events.push(['audio', pcm.length])
  });
  assert.deepEqual(events[0], ['start', 'Dentist at 9.', 'answer']);
  assert.deepEqual(events[1], ['speak', 'Dentist at 9.']);
  assert.ok(events.slice(2).every(e => e[0] === 'audio'));
  assert.equal(sent, parseWav(toDeviceWav(tone(220, 0.5, 24000))).pcm.length);

  const asked = [];
  await deviceVoiceTurnStream({
    audio: tone(300, 1, 16000), transcribe: async () => 'yes do it', ask: async text => { asked.push(text); return {}; },
    streamSpeech: async function* () {}, onStart: info => events.push(['start', info.reply]), onAudio: () => {}
  });
  assert.deepEqual(asked, []);
  assert.deepEqual(events.at(-1), ['start', SAY.approveOnPhone]);
});

test('the streaming resampler matches the whole-file one exactly, however the network splits the bytes', () => {
  const { createStreamingResampler } = require('../../api/services/device-audio');
  const pcm = Buffer.alloc(24000 * 2 * 2 + 14);
  let s = 0;
  for (let i = 0; i < pcm.length / 2; i++) {
    s = 0.97 * s + Math.sin(i * 1.7) * 900;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s + 4000 * Math.sin(i / 9)))), i * 2);
  }
  const whole = parseWav(toDeviceWav(wavFromPcm16(pcm, 24000))).pcm;
  for (const size of [1, 3, 160, 4097, pcm.length]) {
    const r = createStreamingResampler(24000);
    const parts = [];
    for (let o = 0; o < pcm.length; o += size) parts.push(r.push(pcm.subarray(o, o + size)));
    parts.push(r.flush());
    assert.ok(Buffer.concat(parts).equals(whole), `chunk size ${size}`);
  }
});
