'use strict';

const MAX_CHOICES = 3;
const LONDON_TIME_ZONE = 'Europe/London';

function cleanText(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function dateAtStartOfWeek(date) {
  const value = new Date(date);
  const day = value.getUTCDay();
  value.setUTCDate(value.getUTCDate() + (day === 0 ? -6 : 1 - day));
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

function dateRangeForRequest(text, now = new Date()) {
  const lower = String(text || '').toLowerCase();
  if (!/\b(?:next|this) week\b/.test(lower)) return null;
  const start = dateAtStartOfWeek(now);
  if (/\bnext week\b/.test(lower)) start.setUTCDate(start.getUTCDate() + 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start: start.toISOString(), end: end.toISOString(), label: /\bnext week\b/.test(lower) ? 'next week' : 'this week' };
}

function appointmentServiceFromRequest(text) {
  const value = cleanText(text);
  const direct = value.match(/\b(?:get|book|find|arrange|schedule)\s+(?:me\s+)?(?:an?\s+)?(.+?)\s+appointment\b/i);
  const withProvider = value.match(/\bappointment\s+(?:with|at)\s+(.+?)(?:\s+(?:next|this|after|before|on|in)\b|$)/i);
  const candidate = direct?.[1] || withProvider?.[1] || '';
  const cleaned = cleanText(candidate.replace(/\b(?:for|please)\b.*$/i, ''), 80).replace(/^(?:a|an|the)\s+/i, '');
  return /^(?:a|an|the)?$/i.test(cleaned) ? '' : cleaned;
}

function preferenceFromRequest(text) {
  const lower = String(text || '').toLowerCase();
  if (/\bafter work\b|\bevenings?\b/.test(lower)) return { id: 'after_work', label: 'after work' };
  if (/\bmornings?\b/.test(lower)) return { id: 'morning', label: 'in the morning' };
  if (/\bafternoons?\b/.test(lower)) return { id: 'afternoon', label: 'in the afternoon' };
  return { id: 'any_time', label: 'at any time' };
}

function parseAppointmentRequest(request, now = new Date()) {
  const text = cleanText(request, 400);
  const service = appointmentServiceFromRequest(text);
  const window = dateRangeForRequest(text, now);
  const missing = [];
  if (!service) missing.push('service');
  if (!window) missing.push('time');
  return { request: text, service, window, preference: preferenceFromRequest(text), missing };
}

function asDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function overlaps(a, b) {
  const aStart = asDate(a?.start);
  const aEnd = asDate(a?.end);
  const bStart = asDate(b?.start);
  const bEnd = asDate(b?.end);
  return Boolean(aStart && aEnd && bStart && bEnd && aStart < bEnd && aEnd > bStart);
}

function matchesPreference(slot, preference) {
  const date = asDate(slot?.start);
  if (!date) return false;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(date));
  if (preference?.id === 'after_work') return hour >= 17;
  if (preference?.id === 'morning') return hour < 12;
  if (preference?.id === 'afternoon') return hour >= 12 && hour < 17;
  return true;
}

function formatSlot(start, end) {
  const startText = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(start);
  const endText = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(end);
  return `${startText}–${endText}`;
}

function safeChoice(slot, service) {
  const start = asDate(slot?.start);
  const end = asDate(slot?.end);
  if (!slot?.id || !start || !end || end <= start) return null;
  return { id: cleanText(slot.id, 100), start: start.toISOString(), end: end.toISOString(), service: cleanText(service, 80), label: formatSlot(start, end) };
}

function missingDetailMessage(missing) {
  if (missing.includes('service')) return 'What kind of appointment should I look for?';
  if (missing.includes('time')) return 'When should I look?';
  return 'I need one more detail before I look.';
}

function createSandboxAppointmentProvider() {
  const bookings = [];
  return {
    id: 'sandbox',
    async findSlots({ request }) {
      const start = asDate(request?.window?.start) || new Date();
      return [0, 1, 2, 3].map(offset => {
        const at = new Date(start);
        at.setUTCDate(at.getUTCDate() + offset + 1);
        at.setUTCHours(17 + (offset % 2), 30, 0, 0);
        return { id: `sandbox-${at.toISOString()}`, start: at.toISOString(), end: new Date(at.getTime() + 30 * 60 * 1000).toISOString() };
      });
    },
    async book(choice) {
      const booking = { id: `sandbox-booking-${bookings.length + 1}`, reference: `Sandbox ${String(bookings.length + 1).padStart(4, '0')}`, choice: { ...choice } };
      bookings.push(booking);
      return booking;
    },
    bookings: () => bookings.map(booking => ({ ...booking }))
  };
}

function createSandboxCalendar() {
  const events = [];
  return {
    async add(choice) {
      const event = { id: `sandbox-calendar-${events.length + 1}`, title: `${choice.service} appointment`, start: choice.start, end: choice.end };
      events.push(event);
      return event;
    },
    events: () => events.map(event => ({ ...event }))
  };
}

function createAppointmentBookingService({ provider, calendar } = {}) {
  if (!provider || typeof provider.findSlots !== 'function' || typeof provider.book !== 'function') throw new TypeError('An appointment provider with findSlots and book is required.');
  return {
    async findChoices({ request, calendarEvents = [], now = new Date() } = {}) {
      const parsed = parseAppointmentRequest(request, now);
      if (parsed.missing.length) return { ok: false, kind: 'missing_details', missing: parsed.missing, text: missingDetailMessage(parsed.missing), request: parsed };
      const choices = (await provider.findSlots({ request: parsed }))
        .map(slot => safeChoice(slot, parsed.service)).filter(Boolean)
        .filter(choice => matchesPreference(choice, parsed.preference))
        .filter(choice => !calendarEvents.some(event => overlaps(choice, event))).slice(0, MAX_CHOICES);
      if (!choices.length) return { ok: false, kind: 'no_choices', text: "I couldn't find a free appointment that fits. I saved this so we can try another time.", request: parsed, choices: [] };
      return { ok: true, provider: provider.id, service: parsed.service, preference: parsed.preference, request: parsed, choices };
    },
    async commitChoice({ choice, approved = false } = {}) {
      if (!approved) return { ok: false, kind: 'approval_required', text: 'This needs your OK before I book it.' };
      if (!choice?.id || !choice?.start || !choice?.end || !choice?.service) return { ok: false, kind: 'invalid_choice', text: "I couldn't find that appointment choice. Please pick one again." };
      const booking = await provider.book(choice);
      if (!booking?.reference) return { ok: false, kind: 'provider_failed', text: "I couldn't confirm that appointment. Your task is saved so you can try again." };
      return this.addBookingToCalendar({ booking: { id: booking.id || null, reference: cleanText(booking.reference, 120), choice: { ...choice } } });
    },
    async addBookingToCalendar({ booking } = {}) {
      const choice = booking?.choice;
      if (!choice?.id || !choice?.start || !choice?.end || !choice?.service) return { ok: false, kind: 'invalid_choice', text: "I couldn't find that appointment choice. Please pick one again." };
      if (!calendar || typeof calendar.add !== 'function') return { ok: false, kind: 'calendar_unavailable', booking, text: "The appointment is booked, but I couldn't add it to your calendar. I've kept this open so I can try again." };
      try {
        const event = await calendar.add(choice, booking);
        if (!event?.id) throw new Error('Calendar did not return an event.');
        return { ok: true, booking, calendarEvent: { id: event.id, title: cleanText(event.title || '', 160) || null } };
      } catch {
        return { ok: false, kind: 'calendar_failed', booking, text: "The appointment is booked, but I couldn't add it to your calendar. I've kept this open so I can try again." };
      }
    }
  };
}

module.exports = { createAppointmentBookingService, createSandboxAppointmentProvider, createSandboxCalendar, parseAppointmentRequest, formatSlot, overlaps };
