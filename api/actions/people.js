'use strict';

// People, commitments and occasions actions, lifted out of the switch in api/index.js.
//
// The service modules are required as objects and called as properties, not destructured
// at require time. That is deliberate: the orchestration tests monkey-patch methods on the
// shared module object (scheduledTasks.createScheduledTask = ...), which only works while
// the call site resolves the property at call time.

const { escapeIlikePattern } = require('../lib/text');
const {
  isValidMonthDay,
  daysUntil,
  computeReminderDueDate,
  formatMonthDay,
  formatOccasionsSummary
} = require('../services/occasions');
const people = require('../services/people');
const commitments = require('../services/commitments');
const scheduledTasks = require('../services/scheduled-tasks');

// Durable birthday/occasion capture. Deliberately its own table (occasions), not the
// free-text memories table — "whose birthday is coming up?" needs a real date to sort on,
// not prose to re-parse on every request. select-then-insert-or-update rather than a DB
// upsert: the unique index is on lower(person_name), an expression PostgREST's on_conflict
// param can't target reliably, and birthdays are input rarely enough that the tiny race
// window is not worth the complexity.
async function saveOccasion({ userId, action, params, enrichedParams, context, deps }) {
  const { supabase } = deps;
  const personName = String(params?.person_name || '').trim();
  const occasionType = (String(params?.occasion_type || 'birthday').trim().toLowerCase()) || 'birthday';
  const month = Number(params?.month);
  const day = Number(params?.day);
  if (!personName) return { success: false, error: 'save_occasion requires person_name' };
  if (!isValidMonthDay(month, day)) return { success: false, error: 'save_occasion requires a real month (1-12) and a day that exists in that month' };

  const yearNum = Number(params?.year);
  const year = Number.isInteger(yearNum) && yearNum > 1900 && yearNum <= new Date().getFullYear() ? yearNum : null;
  const relationship = params?.relationship ? String(params.relationship).trim().slice(0, 100) : null;
  const notes = params?.notes ? String(params.notes).trim().slice(0, 1000) : null;

  const { data: existing, error: findError } = await supabase
    .from('occasions')
    .select('id')
    .eq('user_id', userId)
    .eq('occasion_type', occasionType)
    .ilike('person_name', escapeIlikePattern(personName))
    .maybeSingle();
  if (findError) return { success: false, error: findError.message };

  // Link the occasion to the canonical person so "get Alisa something for her birthday"
  // connects recipient + occasion + preferences. Deliberately non-blocking: if the name
  // is ambiguous (two Alisas) nothing is merged and the occasion still saves with
  // participant_id null — a wrong link is worse than no link.
  let participantId = null;
  try {
    const resolved = await people.resolvePerson(supabase, userId, { name: personName });
    if (resolved.person) {
      participantId = resolved.person.id;
      if (relationship && !resolved.person.relationship) {
        await supabase.from('participants').update({ relationship, updated_at: new Date().toISOString() }).eq('id', participantId);
      }
    } else if (!resolved.ambiguous) {
      const created = await people.upsertPerson(supabase, userId, { name: personName, relationship, source: 'learned' });
      if (created.success) participantId = created.person.id;
    }
  } catch {
    // The people layer is an enrichment here, never a precondition for saving a birthday.
  }

  const row = { user_id: userId, person_name: personName, occasion_type: occasionType, month, day, year, relationship, notes, updated_at: new Date().toISOString() };
  // Only ever set the link, never clear one that already resolved on an earlier save.
  if (participantId) row.participant_id = participantId;
  const { error } = existing?.id
    ? await supabase.from('occasions').update(row).eq('id', existing.id)
    : await supabase.from('occasions').insert({ ...row, source: 'chat' });
  if (error) return { success: false, error: error.message };

  let reminderScheduled = false;
  let reminderText = '';
  const remindDaysBeforeNum = Number(params?.remind_days_before);
  const wantsReminder = params?.remind_on_day === true || Number.isFinite(remindDaysBeforeNum);
  if (wantsReminder) {
    const offset = params?.remind_on_day === true ? 0 : Math.max(0, remindDaysBeforeNum);
    const dueDate = computeReminderDueDate(month, day, offset, new Date());
    const isBirthday = occasionType === 'birthday';
    // Same composition pattern as the delivery-watch reminders: recurrence:'once' with a
    // computed due_date, and the instruction tells Millie to re-arm itself for next year
    // after firing — no new scheduler cadence needed (isRecurringCadence only supports
    // daily/weekly today, and adding 'yearly' there is scheduler-internals work this pass
    // is explicitly not meant to spend time on).
    const created = await scheduledTasks.createScheduledTask(userId, {
      title: `${personName}'s ${occasionType}`,
      instruction: `Tell the user ${personName}'s ${occasionType} is coming up${offset > 0 ? ` in ${offset} day${offset === 1 ? '' : 's'}` : ' today'} (${formatMonthDay(month, day)}).${isBirthday ? ' Offer to help find and buy a gift if they want one: ask their budget if not already known, use web_search for real current options given what you know about the person (relationship, interests, past gifts if mentioned), and run_browser_task for an actual purchase — never say something was bought until that flow actually confirms it.' : ''} After delivering this reminder, call create_scheduled_task again with the same title, recurrence \'once\', and due_date set to exactly one year from today\'s date, so this keeps coming back every year without the user having to ask again.`,
      recurrence: 'once',
      due_date: dueDate.toISOString(),
      time: '09:00'
    });
    reminderScheduled = Boolean(created?.success);
    reminderText = reminderScheduled
      ? ` I'll remind you ${offset > 0 ? `${offset} day${offset === 1 ? '' : 's'} before` : 'on the day'} (around ${formatMonthDay(dueDate.getUTCMonth() + 1, dueDate.getUTCDate())}).`
      : ' (the reminder could not be set up — you can ask again separately.)';
  }

  return {
    success: true,
    occasion: { personName, occasionType, month, day, year, relationship, notes },
    reminderScheduled,
    text: `Saved ${personName}'s ${occasionType} (${formatMonthDay(month, day)}).${reminderText}`
  };
}

async function findOccasions({ userId, action, params, enrichedParams, context, deps }) {
  const { supabase } = deps;
  const personFilter = params?.person_name ? String(params.person_name).trim() : '';
  let query = supabase.from('occasions').select('person_name, occasion_type, month, day, year, relationship, notes').eq('user_id', userId);
  if (personFilter) query = query.ilike('person_name', `%${escapeIlikePattern(personFilter)}%`);
  const { data, error } = await query;
  if (error) return { success: false, error: error.message };

  const items = (data || []).map(row => ({
    personName: row.person_name,
    occasionType: row.occasion_type,
    month: row.month,
    day: row.day,
    year: row.year,
    relationship: row.relationship,
    notes: row.notes,
    daysUntil: daysUntil(row.month, row.day)
  }));

  if (personFilter && !items.length) {
    return { success: true, items: [], text: `I don't have a saved birthday or occasion for "${personFilter}".` };
  }

  return {
    success: true,
    items,
    text: formatOccasionsSummary(items)
  };
}

// ── Commitments ───────────────────────────────────────────────────────────────────
// What the user said they would do. Linked to the people layer and the scheduler rather
// than re-implementing either.
async function trackCommitment({ userId, action, params, enrichedParams, context, deps }) {
  const { supabase } = deps;
  const what = String(params?.what || '').trim().slice(0, commitments.MAX_WHAT);
  if (!what) return { success: false, error: 'track_commitment needs what was promised' };

  const personName = String(params?.person_name || '').trim();
  let participantId = null;
  if (personName) {
    const resolved = await people.resolvePerson(supabase, userId, { name: personName, email: params?.person_email });
    if (resolved.person) participantId = resolved.person.id;
  }

  const whenText = String(params?.due || '').trim();
  const parsed = whenText ? commitments.extractDueDate(whenText, new Date()) : { dueAt: null, dateOnly: false };
  const explicitDue = params?.due_at && !Number.isNaN(Date.parse(params.due_at)) ? new Date(params.due_at) : null;
  const dueAt = explicitDue || parsed.dueAt;

  const row = {
    user_id: userId,
    what,
    participant_id: participantId,
    person_name: personName || null,
    due_at: dueAt ? dueAt.toISOString() : null,
    due_is_date_only: explicitDue ? false : parsed.dateOnly,
    source: ['stated', 'sent_email', 'email_context'].includes(params?.source) ? params.source : 'stated',
    source_ref: params?.source_ref || null,
    thread_id: params?.thread_id || null,
    updated_at: new Date().toISOString()
  };

  // Re-stating the same promise updates it (a new date) rather than creating a second
  // obligation. But "send the report" to Mia and "send the report" to Ben are two real,
  // separate obligations that happen to share wording — matching on `what` alone (as this
  // used to) found Mia's open row on the second call and silently overwrote her
  // commitment with Ben's, losing it entirely. Matched now on exactly the same key the
  // table's own unique index declares (what + person_name, including "neither has one" as
  // its own bucket) — the DB constraint was already the correct invariant; the app-level
  // pre-check just wasn't consistent with it.
  let existingQuery = supabase.from('commitments')
    .select('id').eq('user_id', userId).eq('status', 'open')
    .ilike('what', escapeIlikePattern(what));
  existingQuery = personName
    ? existingQuery.ilike('person_name', escapeIlikePattern(personName))
    : existingQuery.is('person_name', null);
  const { data: existing } = await existingQuery.maybeSingle();

  const { data, error } = existing?.id
    ? await supabase.from('commitments').update(row).eq('id', existing.id).select('*').single()
    : await supabase.from('commitments').insert(row).select('*').single();
  if (error) return { success: false, error: error.message };

  return {
    success: true,
    commitment: data,
    updated: Boolean(existing?.id),
    text: `Noted: ${commitments.describeCommitment(data)}.`
  };
}

async function findCommitments({ userId, action, params, enrichedParams, context, deps }) {
  const { supabase } = deps;
  const personFilter = String(params?.person_name || '').trim();
  const scope = String(params?.scope || 'open').trim().toLowerCase();
  let query = supabase.from('commitments').select('*').eq('user_id', userId);
  if (scope !== 'all') query = query.eq('status', scope === 'done' ? 'done' : 'open');
  if (personFilter) query = query.ilike('person_name', `%${escapeIlikePattern(personFilter)}%`);
  const { data, error } = await query.order('due_at', { ascending: true, nullsFirst: false }).limit(50);
  if (error) return { success: false, error: error.message };

  const now = new Date();
  let items = data || [];
  if (String(params?.overdue_only) === 'true' || params?.overdue_only === true) {
    items = items.filter(c => commitments.isOverdue(c, now));
  }
  return {
    success: true,
    commitments: commitments.sortCommitments(items, now).map(c => ({
      id: c.id, what: c.what, personName: c.person_name, dueAt: c.due_at,
      status: c.status, overdue: commitments.isOverdue(c, now),
      dueToday: commitments.isDueToday(c, now), threadId: c.thread_id, source: c.source
    })),
    text: commitments.formatCommitmentList(items, { now, person: personFilter })
  };
}

async function resolveCommitment({ userId, action, params, enrichedParams, context, deps }) {
  const { supabase } = deps;
  const query = String(params?.what || params?.id || '').trim();
  const personFilter = String(params?.person_name || '').trim();
  if (!query) return { success: false, error: 'Say which commitment — what was it?' };
  const outcome = params?.outcome === 'cancelled' ? 'cancelled' : 'done';

  let row = null;
  if (/^[0-9a-f-]{36}$/i.test(query)) {
    const { data } = await supabase.from('commitments').select('*').eq('id', query).eq('user_id', userId).maybeSingle();
    row = data;
  } else {
    // Narrowing by person is what lets "I already sent Ben the report" resolve cleanly
    // even while "send Mia the report" is also open — without it, a `what`-only search
    // for "report" would be ambiguous between the two for no good reason.
    let matchQuery = supabase.from('commitments').select('*')
      .eq('user_id', userId).eq('status', 'open')
      .ilike('what', `%${escapeIlikePattern(query)}%`);
    if (personFilter) matchQuery = matchQuery.ilike('person_name', `%${escapeIlikePattern(personFilter)}%`);
    // High enough that a genuinely long candidate list is still reported honestly (not
    // truncated to "more than one" without saying how many), while staying a bounded query.
    const { data } = await matchQuery.limit(10);
    if (data?.length > 1) {
      return {
        success: false,
        ambiguous: true,
        candidates: data.map(c => ({ id: c.id, what: c.what, personName: c.person_name, dueAt: c.due_at })),
        error: `More than one matches "${query}"${personFilter ? ` for ${personFilter}` : ''}: ${data.map(c => c.what).join('; ')}. Which one?`
      };
    }
    row = data?.[0] || null;
  }
  if (!row) return { success: false, error: `I don't have an open commitment matching "${query}"${personFilter ? ` for ${personFilter}` : ''}.` };

  const { error } = await supabase.from('commitments').update({
    status: outcome,
    resolved_at: new Date().toISOString(),
    // Recorded so an auto-resolution can always be told apart from the user saying so.
    resolved_by: String(params?.resolved_by || 'user').slice(0, 40),
    updated_at: new Date().toISOString()
  }).eq('id', row.id);
  if (error) return { success: false, error: error.message };
  return {
    success: true,
    text: outcome === 'cancelled' ? `Dropped: ${row.what}.` : `Marked done: ${row.what}.`
  };
}

// ── People layer ──────────────────────────────────────────────────────────────────
// Built on participants/participant_addresses (see api/services/people.js for why
// that, and not a new table). These three cases are thin: all the identity-resolution
// rules — handles beat names, ambiguous names are never merged — live in the service.
async function rememberPerson({ userId, action, params, enrichedParams, context, deps }) {
  const { supabase } = deps;
  const result = await people.upsertPerson(supabase, userId, {
    name: params?.person_name || params?.name,
    relationship: params?.relationship,
    email: params?.email,
    phone: params?.phone,
    businessName: params?.business_name,
    facts: params?.facts ?? params?.note,
    removeFacts: params?.replaces,
    forceNew: params?.different_person === true || String(params?.different_person) === 'true',
    factKind: params?.fact_kind
  });
  if (result.ambiguous) {
    return {
      success: false,
      ambiguous: true,
      candidates: result.candidates,
      error: `${result.error} Say which one you mean, or that this is a different person.`
    };
  }
  if (!result.success) return result;

  const profile = (await people.loadProfiles(supabase, userId, [result.person]))[0];
  const changes = [
    result.created ? 'added' : 'updated',
    result.factsRemoved ? `${result.factsRemoved} thing${result.factsRemoved === 1 ? '' : 's'} forgotten` : '',
    result.factsAdded ? `${result.factsAdded} noted` : ''
  ].filter(Boolean).join(', ');
  return { success: true, person: profile, created: result.created, text: `${people.formatProfile(profile)} (${changes}).` };
}

async function findPeople({ userId, action, params, enrichedParams, context, deps }) {
  const { supabase } = deps;
  const query = String(params?.query || params?.person_name || '').trim();
  const result = await people.findPeople(supabase, userId, {
    query,
    relationship: params?.relationship,
    email: params?.email,
    phone: params?.phone
  });
  return {
    success: true,
    people: result.profiles,
    ambiguous: Boolean(result.ambiguous),
    text: people.formatPeopleSummary(result.profiles, { ambiguous: result.ambiguous, query: query || params?.relationship || '' })
  };
}

async function forgetPersonDetail({ userId, action, params, enrichedParams, context, deps }) {
  const { supabase } = deps;
  const query = String(params?.person_name || params?.query || '').trim();
  const resolved = await people.resolvePerson(supabase, userId, { name: query, email: params?.email, phone: params?.phone });
  if (resolved.ambiguous) {
    return { success: false, ambiguous: true, error: `More than one person matches "${query}". Which one?` };
  }
  if (!resolved.person) return { success: false, error: `I don't have anyone saved as "${query}".` };

  const result = await people.forgetPersonDetail(supabase, userId, {
    participantId: resolved.person.id,
    facts: params?.facts ?? params?.fact,
    clearRelationship: params?.clear_relationship === true || String(params?.clear_relationship) === 'true',
    deletePerson: params?.delete_person === true || String(params?.delete_person) === 'true'
  });
  if (!result.success) return result;
  const name = resolved.person.display_name;
  const text = result.deleted ? `Forgot ${name} entirely.`
    : [
      result.relationshipCleared ? `${name} is no longer recorded with that relationship` : '',
      result.factsRemoved ? `forgot ${result.factsRemoved} thing${result.factsRemoved === 1 ? '' : 's'} about ${name}` : ''
    ].filter(Boolean).join('; ') || `Nothing to forget about ${name}.`;
  return { success: true, ...result, text };
}

module.exports = {
  handlers: {
    save_occasion: saveOccasion,
    find_occasions: findOccasions,
    track_commitment: trackCommitment,
    find_commitments: findCommitments,
    resolve_commitment: resolveCommitment,
    remember_person: rememberPerson,
    find_people: findPeople,
    forget_person_detail: forgetPersonDetail
  }
};
