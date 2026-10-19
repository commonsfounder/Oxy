'use strict';

// The app's own settings, changed by asking in chat. The phone applies the change; the server only
// checks it is a real setting with a real value and says what was changed.

const SETTINGS = Object.freeze({
  appearance: { values: ['automatic', 'warm', 'sea', 'night'], say: (v) => `Switched to the ${v} look.` },
  maps_app: { values: ['apple', 'google'], say: (v) => `Directions will open in ${v === 'apple' ? 'Apple Maps' : 'Google Maps'}.` },
  how_proactive: { values: ['reactive', 'reserved', 'balanced', 'proactive', 'autonomous'], say: (v) => ({ reactive: 'I will wait until you ask.', reserved: 'I will only suggest things now and then.', balanced: 'Back to helpful, not noisy.', proactive: 'I will look for useful things to do.', autonomous: 'I will take care of everyday things myself. I still ask before spending or sending.' }[v]) },
  ask_before_acting: { values: ['on', 'off'], say: (v) => (v === 'on' ? 'I will ask before every action.' : 'I will only ask when it matters.') },
  ask_before_private_apps: { values: ['on', 'off'], say: (v) => (v === 'on' ? 'I will ask before opening private apps.' : 'I will open private apps without asking.') },
  alert_arriving_leaving: { values: ['on', 'off'], say: (v) => (v === 'on' ? 'Arriving and leaving reminders are on.' : 'Arriving and leaving reminders are off.') },
  daily_check_in: { values: ['on', 'off'], say: (v) => (v === 'on' ? 'Daily check-ins are on.' : 'Daily check-ins are off.') },
  listen_for_sounds: { values: ['on', 'off'], say: (v) => (v === 'on' ? 'I will listen for alarms and doorbells while the app is open.' : 'I have stopped listening for sounds.') },
  learn_from_photos: { values: ['on', 'off', 'scan_now'], say: (v) => ({ on: 'I will start looking through your photos.', off: 'I have stopped looking through your photos.', scan_now: 'Looking through your photos now.' }[v]) }
});

async function changeSetting({ params }) {
  const setting = String(params?.setting || '').trim().toLowerCase();
  const value = String(params?.value ?? '').trim().toLowerCase();
  const spec = SETTINGS[setting];
  if (!spec) return { success: false, error: `That is not something I can change. I can change: ${Object.keys(SETTINGS).join(', ')}.` };
  if (!spec.values.includes(value)) return { success: false, error: `${setting} can be ${spec.values.join(', ')}.` };
  return { success: true, text: spec.say(value), clientEffect: { setting, value } };
}

module.exports = { handlers: { change_setting: changeSetting }, SETTINGS };
