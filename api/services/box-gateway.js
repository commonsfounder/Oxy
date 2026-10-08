'use strict';

// Routes for a paired speaker-display with a microphone (the BOX-3 stand-in). It is an ordinary paired display, so it uses the
// same bearer token and the same ask rules: it can talk to Adam but can never approve or cancel anything.

const express = require('express');
const displayAsk = require('./display-ask');
const sensorFusion = require('./sensor-fusion');

const RATE = 16000;
const MIN_AUDIO_BYTES = RATE * 2 * 0.4;
const MAX_AUDIO_BYTES = RATE * 2 * 15;
const MAX_SPOKEN = 500;
const SENSOR_FRESH_MS = 2 * 60 * 1000;
const SOUND_BUCKET_MS = 10 * 60 * 1000;
const PHONE_ONLY = 'Open Adam on your phone to approve that.';
const ROOM_WORDS = /\b(temperature|humid|humidity|warm|cold|hot|chilly|stuffy|damp|room)\b/i;

const SOUND_REPORTS = Object.freeze({
  smoke_alarm: { title: 'Smoke alarm heard', body: 'A smoke alarm pattern was heard. Check now.', urgent: true },
  carbon_monoxide_alarm: { title: 'Carbon monoxide alarm heard', body: 'A carbon monoxide alarm pattern was heard. Check now.', urgent: true },
  sustained_beeping: { title: 'Steady beeping heard', body: 'It could be an alarm or a clock.', urgent: false }
});

function pcmToWav(pcm, sampleRate = RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Mono 16 kHz signed 16-bit samples from a PCM WAV of any rate, by linear interpolation.
function wavToPcm16k(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file.');
  let offset = 12, rate = 0, channels = 1, bits = 16, data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (wav.readUInt16LE(body) !== 1) throw new Error('Only PCM audio is supported.');
      channels = wav.readUInt16LE(body + 2); rate = wav.readUInt32LE(body + 4); bits = wav.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = wav.subarray(body, Math.min(body + size, wav.length));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!data || !rate || bits !== 16 || channels < 1) throw new Error('Unsupported WAV format.');
  const frames = Math.floor(data.length / (2 * channels));
  const source = new Int16Array(frames);
  for (let i = 0; i < frames; i++) source[i] = data.readInt16LE(i * 2 * channels);
  if (rate === RATE) return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const count = Math.floor(frames * RATE / rate);
  const out = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const position = i * rate / RATE, index = Math.floor(position), fraction = position - index;
    const a = source[index], b = source[Math.min(index + 1, frames - 1)];
    out.writeInt16LE(Math.round(a + (b - a) * fraction), i * 2);
  }
  return out;
}

function isSilent(pcm) {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  return peak < 300;
}

// What the box measured, kept small. Radar is only a movement signal: it never says whether anyone is in the room.
function summarizeSensors(snapshot) {
  const environment = snapshot?.environment;
  const reading = {};
  if (environment?.available && Number.isFinite(environment.temperatureC)) reading.temperatureC = Math.round(environment.temperatureC * 10) / 10;
  if (environment?.available && Number.isFinite(environment.humidityPercent) && environment.humidityPercent >= 0 && environment.humidityPercent <= 100) reading.humidityPercent = Math.round(environment.humidityPercent);
  if (snapshot?.radar?.available && snapshot.radar.configured && typeof snapshot.radar.motionSignal === 'boolean') reading.movementSignal = snapshot.radar.motionSignal;
  return Object.keys(reading).length ? reading : null;
}

function roomLine(reading, ageMs) {
  if (!reading) return '';
  const parts = [];
  if (reading.temperatureC !== undefined) parts.push(`${reading.temperatureC} C`);
  if (reading.humidityPercent !== undefined) parts.push(`${reading.humidityPercent}% humidity`);
  if (!parts.length) return '';
  return `(Readings from the box in this room, ${Math.max(0, Math.round(ageMs / 1000))} seconds ago: ${parts.join(', ')}. These are readings only; they do not show whether anyone is in the room.)`;
}

function soundEvent(displayId, type, now = new Date()) {
  const report = SOUND_REPORTS[type];
  if (!report) return null;
  const bucket = Math.floor(now.getTime() / SOUND_BUCKET_MS);
  return {
    id: `box:${displayId}:${type}:${bucket}`, type: 'sound_detected', title: report.title, subject: report.title, body: report.body,
    occurredAt: now.toISOString(), source: 'adam-box', confidence: 0.9, relevance: 1, actionable: true,
    urgent: report.urgent, requiresNow: report.urgent
  };
}

function registerBoxRoutes(app, deps) {
  const { supabase, pairedDisplays, displayBearerToken, bridgeToChatPipeline, buildDisplayChatRequest, evaluateAndSurfaceHouseholdEvents,
    voice, reactions, findPendingAction, log = () => {} } = deps;
  const fusion = deps.fusion || sensorFusion.createFusion();
  const sensors = new Map();
  const signalTimes = new Map();
  app.use(['/display/:id/voice', '/display/:id/sensors', '/display/:id/sound', '/display/:id/signal'], (req, res, next) => {
    res.on('finish', () => log('info', 'box.request', { route: req.path.split('/').pop(), status: res.statusCode, bytes: Number(req.headers['content-length'] || 0) }));
    next();
  });
  const lastSound = new Map();

  async function authorise(req, res) {
    const display = await pairedDisplays.displayForToken(supabase, req.params.id, displayBearerToken(req));
    if (!display) res.status(401).json({ error: 'Display authorization is invalid.' });
    return display;
  }

  async function speak(text) {
    const wav = Buffer.from(await voice.synthesizeSpeech(text), 'base64');
    return wavToPcm16k(wav);
  }

  function sendAudio(res, pcm, heard, reply) {
    res.set({
      'Content-Type': 'application/octet-stream', 'X-Audio-Rate': String(RATE),
      'X-Adam-Heard': encodeURIComponent(heard.slice(0, 200)), 'X-Adam-Reply': encodeURIComponent(reply.slice(0, 300))
    });
    res.send(pcm);
  }

  // Sounds and other sensors are combined over a short window. Combining only adds to what is raised: a smoke or CO
  // alarm heard on its own is still raised at once by the sound route.
  async function raiseFindings(userId, signal, now) {
    const findings = fusion.ingest(userId, signal);
    if (!findings.length) return 0;
    const outcome = await evaluateAndSurfaceHouseholdEvents(userId, findings.map(finding => sensorFusion.findingToEvent(finding, now)), now);
    return outcome.raised;
  }

  // Some alerts wait for a grace period (a door opening before the phone says someone is home), so houses are re-checked now and then.
  const sweepTimer = setInterval(async () => {
    try {
      for (const { userId, findings } of fusion.sweep()) {
        const now = new Date();
        await evaluateAndSurfaceHouseholdEvents(userId, findings.map(finding => sensorFusion.findingToEvent(finding, now)), now);
      }
    } catch (e) { log('warn', 'box.sweep.failed', { error: e.message }); }
  }, deps.sweepMs ?? 15000);
  sweepTimer.unref?.();

  app.post('/display/:id/voice', express.raw({ type: 'application/octet-stream', limit: MAX_AUDIO_BYTES + 1024 }), async (req, res) => {
    try {
      const display = await authorise(req, res);
      if (!display) return;
      const pcm = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (pcm.length < MIN_AUDIO_BYTES || pcm.length > MAX_AUDIO_BYTES || pcm.length % 2) return res.status(400).json({ error: 'That recording was the wrong length.', code: 'bad_audio' });
      if (isSilent(pcm)) return res.status(422).json({ error: 'I did not hear anything.', code: 'no_speech' });
      displayAsk.checkAskRate(display.id);
      const heard = await voice.transcribe(pcmToWav(pcm));
      if (!heard) return res.status(422).json({ error: 'I did not catch that.', code: 'no_speech' });

      let reply;
      try {
        const text = displayAsk.validateDisplayAsk(heard);
        const fresh = sensors.get(display.id);
        const context = fresh && Date.now() - fresh.at < SENSOR_FRESH_MS && ROOM_WORDS.test(text) ? roomLine(fresh.reading, Date.now() - fresh.at) : '';
        const result = await bridgeToChatPipeline(display.user_id, context ? `${text}\n\n${context}` : text, req, buildDisplayChatRequest);
        if (findPendingAction(result?.actions || [])) reply = PHONE_ONLY;
        else reply = reactions.isQuietReply(result?.text) ? 'Done.' : reactions.plainReply(result?.text || 'Done.');
      } catch (e) {
        if (e?.code !== 'needs_phone') throw e;
        reply = PHONE_ONLY;
      }
      const spoken = reply.length > MAX_SPOKEN ? `${reply.slice(0, MAX_SPOKEN).replace(/\s+\S*$/, '')}. There is more on your phone.` : reply;
      sendAudio(res, await speak(spoken), heard, spoken);
    } catch (e) {
      log('warn', 'box.voice.failed', { error: e.message });
      if (e?.code === 'too_fast') return res.status(429).json({ error: e.message, code: 'too_fast' });
      if (!res.headersSent) res.status(503).json({ error: 'Adam could not answer just now.', code: 'unavailable' });
    }
  });

  app.post('/display/:id/sensors', async (req, res) => {
    try {
      const display = await authorise(req, res);
      if (!display) return;
      sensors.set(display.id, { at: Date.now(), reading: summarizeSensors(req.body) });
      if (sensors.size > 200) for (const [id, entry] of sensors) if (Date.now() - entry.at > SENSOR_FRESH_MS) sensors.delete(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ error: 'Readings are unavailable.' });
    }
  });

  app.post('/display/:id/signal', async (req, res) => {
    try {
      const display = await authorise(req, res);
      if (!display) return;
      const now = Date.now();
      const recent = (signalTimes.get(display.id) || []).filter(at => now - at < 60000);
      if (recent.length >= 30) return res.status(429).json({ error: 'Too many readings. Try again in a moment.' });
      signalTimes.set(display.id, [...recent, now]);
      const signal = { kind: req.body?.kind, name: req.body?.name, value: req.body?.value, room: req.body?.room };
      let raised;
      try { raised = await raiseFindings(display.user_id, signal, new Date(now)); }
      catch (e) { if (e?.code === 'invalid_signal') return res.status(400).json({ error: e.message }); throw e; }
      res.json({ ok: true, raised });
    } catch (e) {
      log('warn', 'box.signal.failed', { error: e.message });
      res.status(503).json({ error: 'That reading could not be recorded.' });
    }
  });

  app.post('/display/:id/sound', async (req, res) => {
    try {
      const display = await authorise(req, res);
      if (!display) return;
      const type = String(req.body?.type || '');
      const now = new Date();
      const event = soundEvent(display.id, type, now);
      if (!event) return res.status(400).json({ error: 'That is not a sound this display reports.' });
      const key = `${display.id}:${type}`;
      if (now.getTime() - (lastSound.get(key) || 0) < 15000) return res.json({ ok: true, raised: 0, deduped: true });
      lastSound.set(key, now.getTime());
      const outcome = await evaluateAndSurfaceHouseholdEvents(display.user_id, [event], now);
      const confirmed = await raiseFindings(display.user_id, { kind: 'sound', name: type }, now);
      res.json({ ok: true, raised: outcome.raised + confirmed });
    } catch (e) {
      log('warn', 'box.sound.failed', { error: e.message });
      res.status(503).json({ error: 'That sound could not be reported.' });
    }
  });
}

module.exports = { registerBoxRoutes, pcmToWav, wavToPcm16k, summarizeSensors, roomLine, soundEvent, isSilent, SOUND_REPORTS };
