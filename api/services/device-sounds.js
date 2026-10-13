'use strict';

// Sounds a paired device heard, turned into household events. The device sends only a key from
// this table and a score; the wording comes from here, so a device can never put its own text in
// front of the person. Wording matches the iPhone's (HouseholdSoundMonitor.swift), and so does the
// event id, so a phone and a device hearing the same alarm make one notification, not two.
//
// `surface` is false for sounds whose measured catch rate isn't good enough to interrupt anyone
// yet (see firmware/sound-events/sound_events_config.h): they are accepted and kept quiet.

const COOLDOWN_SECONDS = 15 * 60;
const MAX_EVENTS = 12;
const MAX_AGE_MS = 15 * 60 * 1000;
const MAX_FUTURE_MS = 60 * 1000;

const SOUNDS = Object.freeze({
  smoke_alarm: { subject: 'Smoke alarm', title: 'Smoke alarm heard', body: 'A smoke alarm is sounding nearby.', relevance: 1, urgent: true, surface: true },
  carbon_monoxide_alarm: { subject: 'Carbon monoxide alarm', title: 'Carbon monoxide alarm heard', body: 'A carbon monoxide alarm is sounding nearby.', relevance: 1, urgent: true, surface: true },
  sustained_beeping: { subject: 'Alarm', title: 'An alarm is going off', body: 'Something has been beeping for over half a minute.', relevance: 1, urgent: false, surface: true },
  alarm: { subject: 'Alarm', title: 'An alarm is going off', body: 'An alarm may be sounding nearby.', relevance: 0.9, urgent: false, surface: true },
  glass_breaking: { subject: 'Breaking glass', title: 'Breaking glass heard', body: 'Glass may have broken nearby.', relevance: 1, urgent: true, surface: true },
  doorbell: { subject: 'Doorbell', title: 'Doorbell heard', body: 'Someone may be at the door.', relevance: 0.9, urgent: false, surface: true },
  knock: { subject: 'Knocking', title: 'Knocking heard', body: 'Someone may be at the door.', relevance: 0.85, urgent: false, surface: true },
  baby_crying: { subject: 'Baby crying', title: 'Baby crying heard', body: 'A baby may need attention.', relevance: 0.9, urgent: false, surface: true },
  water_running: { subject: 'Water running', title: 'Water has been running a while', body: 'A tap or shower may have been left on.', relevance: 0.8, urgent: false, surface: true, sustainedOnly: true },
  cough: { subject: 'Coughing', surface: false },
  dog_bark: { subject: 'Dog barking', surface: false },
  door_slam: { subject: 'Door slam', surface: false },
  gunshot: { subject: 'Bang', surface: false },
  microwave: { subject: 'Microwave', surface: false },
  phone_ring: { subject: 'Phone ringing', surface: false },
  scream: { subject: 'Scream', surface: false },
  siren: { subject: 'Siren', surface: false },
  toilet_flush: { subject: 'Toilet flush', surface: false }
});

// Keys the iPhone uses for the same sound, so ids line up across both.
// (AlarmPatternDetector.Pattern raw values; HouseholdSoundEventFilter rule aliases[0].)
const PHONE_KEY = Object.freeze({ doorbell: 'door_bell', carbon_monoxide_alarm: 'co_alarm', sustained_beeping: 'alarm_beeping', alarm: 'smoke_detector' });

function soundError(message) {
  const error = new Error(message);
  error.code = 'invalid_sounds';
  return error;
}

function deviceSoundEvents(input, { now = new Date(), room = null } = {}) {
  if (!Array.isArray(input) || !input.length) throw soundError('Send at least one sound.');
  if (input.length > MAX_EVENTS) throw soundError(`Send at most ${MAX_EVENTS} sounds at a time.`);
  const at = new Date(now).getTime();
  const events = [];
  const ignored = [];

  for (const item of input) {
    const key = String(item?.sound || '').trim();
    const sound = SOUNDS[key];
    const kind = item?.kind === 'sustained' ? 'sustained' : 'heard';
    const confidence = Number(item?.confidence);
    const occurred = Date.parse(item?.occurredAt || '');
    if (!sound) { ignored.push({ sound: key.slice(0, 40), reason: 'unknown_sound' }); continue; }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) { ignored.push({ sound: key, reason: 'invalid_confidence' }); continue; }
    if (!Number.isFinite(occurred) || occurred > at + MAX_FUTURE_MS) { ignored.push({ sound: key, reason: 'invalid_time' }); continue; }
    if (at - occurred > MAX_AGE_MS) { ignored.push({ sound: key, reason: 'too_old' }); continue; }
    if (sound.sustainedOnly && kind !== 'sustained') { ignored.push({ sound: key, reason: 'not_yet_sustained' }); continue; }

    const bucket = Math.floor(occurred / 1000 / COOLDOWN_SECONDS);
    events.push({
      id: `sound:${PHONE_KEY[key] || key}:${bucket}`,
      type: 'sound_detected',
      subject: sound.subject,
      title: sound.title || sound.subject,
      body: sound.body || sound.subject,
      room,
      occurredAt: new Date(occurred).toISOString(),
      source: 'adam_device',
      confidence,
      relevance: sound.surface ? sound.relevance : 0.2,
      actionable: sound.surface,
      urgent: sound.surface && sound.urgent,
      requiresNow: sound.surface,
      interruptionCost: sound.urgent ? 'low' : 'normal'
    });
  }
  return { events, ignored };
}

module.exports = { SOUNDS, COOLDOWN_SECONDS, deviceSoundEvents };
