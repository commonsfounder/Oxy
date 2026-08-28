'use strict';

// Calendar actions, lifted out of the switch in api/index.js.
//
// `dispatch` arrives through deps rather than being re-imported: the scheduling tests swap
// entries in the connectors registry's shared dispatchOverrides object, and routing through
// the same dispatch function is what keeps that substitution effective.

const { getLocalDateKey } = require('../lib/time');
const scheduling = require('../services/scheduling');
const people = require('../services/people');
const commitments = require('../services/commitments');

// ── Calendar as something you can actually act on ─────────────────────────────────
// Availability is computed by subtracting REAL events from the working window. If the
// calendar cannot be read, this says so rather than inventing free time.
async function findFreeTime({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch } = deps;
  const durationMinutes = Math.max(15, Math.min(Number(params?.duration_minutes) || 60, 480));
  const days = Math.max(1, Math.min(Number(params?.days) || 7, 21));
  const calendar = await dispatch(userId, 'get_calendar_events', { max_results: 100, days });
  if (!calendar?.success) {
    return {
      success: false,
      calendarRead: false,
      error: calendar?.error || 'your calendar was unreachable',
      text: scheduling.formatFreeSlots([], { durationMinutes, calendarRead: false, reason: calendar?.error })
    };
  }

  const working = { ...scheduling.DEFAULT_WORKING };
  if (params?.include_weekends === true || String(params?.include_weekends) === 'true') working.days = [0, 1, 2, 3, 4, 5, 6];
  const slots = scheduling.findFreeSlots({
    events: calendar.events || [],
    from: new Date(),
    days,
    durationMinutes,
    working,
    earliestMinute: scheduling.parseTimeOfDay(params?.earliest),
    latestMinute: scheduling.parseTimeOfDay(params?.latest),
    maxSlots: Math.max(1, Math.min(Number(params?.max_options) || 6, 12))
  });

  return {
    success: true,
    calendarRead: true,
    durationMinutes,
    slots: slots.map(slot => ({ start: slot.start.toISOString(), end: slot.end.toISOString(), label: scheduling.describeSlot(slot) })),
    busyCount: (calendar.events || []).length,
    text: scheduling.formatFreeSlots(slots, { durationMinutes })
  };
}

// Books a real block, at a real free time, without double-booking or duplicating.
async function scheduleBlock({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch } = deps;
  const title = String(params?.title || '').trim();
  if (!title) return { success: false, error: 'schedule_block needs a title' };
  const durationMinutes = Math.max(15, Math.min(Number(params?.duration_minutes) || 60, 480));

  const calendar = await dispatch(userId, 'get_calendar_events', { max_results: 100, days: 21 });
  if (!calendar?.success) {
    return { success: false, error: `I couldn't read your calendar (${calendar?.error || 'unreachable'}), so I won't book anything blind.` };
  }
  const events = calendar.events || [];

  let start = params?.start ? new Date(params.start) : null;
  if (start && Number.isNaN(start.getTime())) start = null;
  if (!start) {
    const [slot] = scheduling.findFreeSlots({
      events, from: new Date(), days: Math.max(1, Math.min(Number(params?.days) || 7, 21)),
      durationMinutes,
      earliestMinute: scheduling.parseTimeOfDay(params?.earliest),
      latestMinute: scheduling.parseTimeOfDay(params?.latest),
      maxSlots: 1
    });
    if (!slot) return { success: false, error: `There's no free ${durationMinutes}-minute slot in that window — your calendar is full across it.` };
    start = slot.start;
  }
  const end = new Date(start.getTime() + durationMinutes * 60000);

  const duplicate = scheduling.findDuplicateEvent({ title, start, events });
  if (duplicate) {
    return { success: true, duplicate: true, eventId: duplicate.id, text: `"${title}" is already in your calendar around then — I haven't added a second one.` };
  }
  const conflicts = scheduling.findConflicts({ start, end, events });
  if (conflicts.length && params?.allow_conflict !== true) {
    return {
      success: false, conflicts,
      error: `That clashes with ${conflicts.map(c => c.title).join(', ')}. Want me to put it somewhere else, or book it anyway?`
    };
  }

  const created = await dispatch(userId, 'create_calendar_event', {
    title, start_date: start.toISOString(), end_date: end.toISOString(),
    description: params?.description || '', attendees: params?.attendees
  });
  if (!created?.success) return { success: false, error: created?.error || 'The calendar rejected that event.' };

  // A block booked FOR a commitment stays linked to it, so the commitment is what gets
  // chased — not the calendar entry.
  if (params?.commitment_id) {
    await supabase.from('commitments').update({ updated_at: new Date().toISOString() })
      .eq('id', params.commitment_id).eq('user_id', userId);
  }
  return {
    success: true,
    eventId: created.eventId,
    start: start.toISOString(),
    end: end.toISOString(),
    invited: created.invited || [],
    text: `Booked "${title}" ${scheduling.describeSlot({ start, end })}${created.invited?.length ? ` and invited ${created.invited.join(', ')}` : ''}.`
  };
}

// Replanning changes the existing event rather than leaving the old time behind.
async function moveCalendarEvent({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch } = deps;
  const eventId = String(params?.event_id || '').trim();
  const query = String(params?.title || '').trim();
  const calendar = await dispatch(userId, 'get_calendar_events', { max_results: 100, days: 30 });
  if (!calendar?.success) return { success: false, error: `I couldn't read your calendar (${calendar?.error || 'unreachable'}).` };
  const events = calendar.events || [];

  let target = eventId ? events.find(e => e.id === eventId) : null;
  if (!target && query) {
    const matches = events.filter(e => String(e.title || '').toLowerCase().includes(query.toLowerCase()));
    if (matches.length > 1) return { success: false, error: `More than one event matches "${query}": ${matches.map(m => m.title).join(', ')}. Which one?` };
    target = matches[0] || null;
  }
  if (!target) return { success: false, error: `I couldn't find an event matching "${query || eventId}".` };

  const start = params?.start ? new Date(params.start) : null;
  if (!start || Number.isNaN(start.getTime())) return { success: false, error: 'move_calendar_event needs a new start time.' };
  const originalStart = new Date(target.start);
  const originalEnd = new Date(target.end || target.start);
  const length = Number(params?.duration_minutes) > 0
    ? Number(params.duration_minutes) * 60000
    : Math.max(originalEnd.getTime() - originalStart.getTime(), 30 * 60000);
  const end = new Date(start.getTime() + length);

  // The event being moved is not a conflict with itself.
  const conflicts = scheduling.findConflicts({ start, end, events: events.filter(e => e.id !== target.id) });
  if (conflicts.length && params?.allow_conflict !== true) {
    return { success: false, conflicts, error: `That would clash with ${conflicts.map(c => c.title).join(', ')}. Somewhere else, or move it anyway?` };
  }

  const updated = await dispatch(userId, 'update_calendar_event', {
    event_id: target.id, start_date: start.toISOString(), end_date: end.toISOString()
  });
  if (!updated?.success) return { success: false, error: updated?.error || 'The calendar rejected that change.' };
  return {
    success: true, eventId: target.id,
    text: `Moved "${target.title}" to ${scheduling.describeSlot({ start, end })}.`
  };
}

// Cancels a real event, resolving it the same way move_calendar_event does: id, then title,
// restricted by date or attendee when given. An ambiguous match is refused rather than guessed,
// and a recurring occurrence with no stated scope asks — deleting the wrong scope of a series
// is not reversible.
async function cancelCalendarEvent({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch } = deps;
  const eventId = String(params?.event_id || '').trim();
  const titleQuery = String(params?.title || '').trim();
  const attendeeQuery = String(params?.person_name || params?.attendee || '').trim();
  const whenText = String(params?.when || params?.date || '').trim().toLowerCase();
  const scope = ['this', 'future', 'series'].includes(String(params?.scope || '').toLowerCase())
    ? params.scope.toLowerCase() : null;

  if (!eventId && !titleQuery && !attendeeQuery && !whenText) {
    return { success: false, error: 'Tell me which event — a title, a time, or who it\'s with.' };
  }

  const calendar = await dispatch(userId, 'get_calendar_events', { max_results: 100, days: 30 });
  if (!calendar?.success) return { success: false, error: `I couldn't read your calendar (${calendar?.error || 'unreachable'}), so I won't cancel anything blind.` };
  let events = calendar.events || [];

  if (eventId) {
    events = events.filter(e => e.id === eventId);
  } else {
    if (titleQuery) {
      events = events.filter(e => String(e.title || '').toLowerCase().includes(titleQuery.toLowerCase()));
    }
    if (attendeeQuery) {
      let attendeeEmail = attendeeQuery.toLowerCase();
      // "the meeting with Ben" — resolve a name to an address through the same people
      // layer commitments use, rather than substring-matching a first name against
      // full email addresses (which would also match "ben.carter@..." for "Ben" AND
      // for "Benedict", so both the name and the resolved address are checked).
      if (!attendeeEmail.includes('@')) {
        const resolved = await people.resolvePerson(supabase, userId, { name: attendeeQuery }).catch(() => null);
        if (resolved?.person?.email) attendeeEmail = resolved.person.email.toLowerCase();
      }
      events = events.filter(e => (e.attendees || []).some(a => a.toLowerCase().includes(attendeeEmail)) ||
        String(e.title || '').toLowerCase().includes(attendeeQuery.toLowerCase()));
    }
    if (whenText === 'today' || whenText === 'tomorrow') {
      const dayKey = getLocalDateKey(new Date(Date.now() + (whenText === 'tomorrow' ? 86400000 : 0)));
      events = events.filter(e => getLocalDateKey(new Date(e.start)) === dayKey);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(whenText)) {
      events = events.filter(e => getLocalDateKey(new Date(e.start)) === whenText);
    }
  }

  if (!events.length) return { success: false, error: `I couldn't find an event matching that.` };
  if (events.length > 1) {
    return {
      success: false,
      ambiguous: true,
      candidates: events.map(e => ({ id: e.id, title: e.title, start: e.start })),
      error: `More than one event matches: ${events.map(e => `"${e.title}" at ${e.start}`).join('; ')}. Which one?`
    };
  }

  const target = events[0];

  // A recurring occurrence with no stated scope is exactly the ambiguity the current
  // action model cannot safely resolve on its own — asking is the correct behaviour,
  // not a fallback for one.
  if (target.recurringEventId && !scope) {
    return {
      success: false,
      needsClarification: true,
      recurring: true,
      eventId: target.id,
      masterEventId: target.recurringEventId,
      error: `"${target.title}" is part of a repeating series. Cancel just this one, this and every one after it, or the whole series?`
    };
  }

  const notifyAttendees = params?.notify_attendees !== false;
  let result;
  if (target.recurringEventId && scope === 'future') {
    result = await dispatch(userId, 'end_recurring_series', {
      event_id: target.recurringEventId, from_date: target.start, notify_attendees: notifyAttendees
    });
  } else {
    const idToDelete = target.recurringEventId && scope === 'series' ? target.recurringEventId : target.id;
    result = await dispatch(userId, 'delete_calendar_event', { event_id: idToDelete, notify_attendees: notifyAttendees });
  }
  if (!result?.success) return { success: false, error: result?.error || 'The calendar would not cancel that.' };

  return {
    success: true,
    eventId: target.id,
    scope: scope || 'this',
    hadAttendees: Boolean(result.hadAttendees),
    notifiedAttendees: Boolean(result.notifiedAttendees),
    text: result.text || `Cancelled "${target.title}".`
  };
}

module.exports = {
  handlers: {
    find_free_time: findFreeTime,
    schedule_block: scheduleBlock,
    move_calendar_event: moveCalendarEvent,
    cancel_calendar_event: cancelCalendarEvent
  }
};
