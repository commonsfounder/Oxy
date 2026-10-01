'use strict';

// The few situations where a screen must show something at once and be right: a possible fall, choking,
// crying. The wording is fixed here, so nothing in the path (no model, no generation, no free text from a
// sensor) can change what a person reads in a moment like that. Detection itself comes from whatever
// reports the event; this only decides what is said and where it goes.

const TEMPLATES = Object.freeze({
  baby_crying: {
    severity: 'urgent', screen: true,
    title: place => `Crying in ${place}`,
    body: () => 'Sounds like real crying, not fussing.'
  },
  fall_detected: {
    severity: 'urgent', screen: true,
    title: place => `Possible fall in ${place}`,
    body: () => 'A heavy fall was heard. Go and check.'
  },
  choking_detected: {
    severity: 'urgent', screen: true,
    title: place => `Possible choking in ${place}`,
    body: () => 'Go to them now.'
  },
  distress_overnight: {
    severity: 'urgent', screen: true,
    title: place => `Someone sounds distressed in ${place}`,
    body: () => 'Overnight. Go and check.'
  },
  baby_fussing: {
    severity: 'low', screen: false,
    title: place => `Fussing in ${place}`,
    body: () => 'Not crying. Worth a listen if it carries on.'
  },
  child_out_of_bed: {
    severity: 'attention', screen: false,
    title: place => `Someone is up in ${place}`,
    body: () => 'After bedtime.'
  }
});

const RESPONSES = Object.freeze(['got_it', 'false_alarm']);

function place(room) {
  const name = String(room ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) return 'the house';
  return /^the\s/i.test(name) ? name.toLowerCase() : `the ${name.toLowerCase()}`;
}

function isUrgentType(type) {
  return Object.hasOwn(TEMPLATES, type);
}

function showsOnScreen(type) {
  return isUrgentType(type) && TEMPLATES[type].screen === true;
}

function describeUrgent(type, { room } = {}) {
  const template = TEMPLATES[type];
  if (!template) return null;
  const where = place(room);
  return { title: template.title(where), body: template.body(where), severity: template.severity, screen: template.screen };
}

module.exports = { TEMPLATES, RESPONSES, URGENT_TYPES: Object.keys(TEMPLATES), isUrgentType, showsOnScreen, describeUrgent };
