'use strict';

// Who someone is, how to reach them, and what is worth remembering about them. Built on
// `participants`/`participant_addresses` rather than a parallel table, which would produce the
// fragmented identity this exists to prevent. Two rules carry it:
//   1. A handle is definitive evidence of identity; a name is not. Records converge through the
//      address index, never through string similarity.
//   2. An ambiguous name merges nothing and guesses nothing — the caller gets the candidates
//      and has to ask, because a wrong merge is invisible and permanent.

const MAX_FACTS_PER_PERSON = 20;
const MAX_FACT_LENGTH = 300;

function cleanText(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeEmail(value) {
  const text = cleanText(value, 320).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) ? text : '';
}

// Phone handles are stored the same way participants.js stores them (trimmed, lowercased);
// the comparison key strips formatting so "+44 7700 900123" and "+447700900123" are one
// handle rather than two.
function normalizePhone(value) {
  const text = cleanText(value, 40);
  const digits = text.replace(/[^\d+]/g, '');
  return digits.length >= 6 ? digits : '';
}

function escapeIlike(value) {
  return String(value ?? '').replace(/[\\%_]/g, m => `\\${m}`);
}

function toFactList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/\s*[;\n]\s*/);
  const seen = new Set();
  const facts = [];
  for (const entry of raw) {
    const fact = cleanText(entry, MAX_FACT_LENGTH);
    if (!fact) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(fact);
  }
  return facts.slice(0, MAX_FACTS_PER_PERSON);
}

// Pure name matching, split out so the ambiguity rule is unit-testable without a database.
// Exact (case-insensitive) beats partial; a single first-name hit against a full name is a
// real match ("James" → "James Whitfield"), but two of them are an ambiguity, not a coin flip.
function rankNameCandidates(candidates = [], name = '') {
  const needle = cleanText(name).toLowerCase();
  if (!needle) return { exact: [], partial: [] };
  const exact = [];
  const partial = [];
  for (const person of candidates) {
    const display = cleanText(person?.display_name).toLowerCase();
    if (!display) continue;
    if (display === needle) exact.push(person);
    else if (display.split(/\s+/).includes(needle) || display.startsWith(`${needle} `)) partial.push(person);
  }
  return { exact, partial };
}

function decideNameMatch(candidates = [], name = '') {
  const { exact, partial } = rankNameCandidates(candidates, name);
  if (exact.length === 1) return { person: exact[0], match: 'name' };
  if (exact.length > 1) return { person: null, ambiguous: true, candidates: exact, match: 'name' };
  if (partial.length === 1) return { person: partial[0], match: 'partial_name' };
  if (partial.length > 1) return { person: null, ambiguous: true, candidates: partial, match: 'partial_name' };
  return { person: null };
}

// When a person was first seen as a bare address, their "name" is that address; learning
// their real name later should replace it. So should learning a fuller version of a name
// already on file ("James" → "James Whitfield"). Nothing else overwrites a name the user
// gave — length is NOT the test, since an email address is usually longer than a real name.
function looksLikeHandle(value) {
  const text = cleanText(value, 320);
  return Boolean(normalizeEmail(text)) || /^[+\d][\d\s().-]{5,}$/.test(text);
}

function shouldReplaceDisplayName(existing, incoming) {
  const current = cleanText(existing, 120);
  const next = cleanText(incoming, 120);
  if (!next || next.toLowerCase() === current.toLowerCase()) return false;
  if (!current) return true;
  if (looksLikeHandle(current)) return !looksLikeHandle(next);
  return next.toLowerCase().startsWith(`${current.toLowerCase()} `);
}

async function findByHandle(supabase, userId, channelType, addressValue) {
  if (!addressValue) return null;
  const { data: addresses } = await supabase
    .from('participant_addresses')
    .select('participant_id')
    .eq('channel_type', channelType)
    .eq('address_value', addressValue);
  if (!addresses?.length) return null;
  const ids = addresses.map(a => a.participant_id);
  const { data: people } = await supabase
    .from('participants')
    .select('*')
    .eq('user_id', userId)
    .in('id', ids)
    .limit(1);
  return people?.[0] || null;
}

async function loadNameCandidates(supabase, userId, name) {
  const needle = cleanText(name);
  if (!needle) return [];
  const { data } = await supabase
    .from('participants')
    .select('*')
    .eq('user_id', userId)
    .ilike('display_name', `%${escapeIlike(needle)}%`)
    .limit(25);
  return data || [];
}

// Resolution order is evidence strength, not convenience: handle, then relationship
// ("email my manager"), then name.
async function resolvePerson(supabase, userId, { name, email, phone, relationship } = {}) {
  const cleanEmail = normalizeEmail(email);
  if (cleanEmail) {
    const person = await findByHandle(supabase, userId, 'email', cleanEmail);
    if (person) return { person, match: 'email' };
  }
  const cleanPhone = normalizePhone(phone);
  if (cleanPhone) {
    const person = await findByHandle(supabase, userId, 'phone_sms', cleanPhone);
    if (person) return { person, match: 'phone' };
  }

  const cleanRelationship = cleanText(relationship, 60);
  if (cleanRelationship) {
    const { data } = await supabase
      .from('participants')
      .select('*')
      .eq('user_id', userId)
      .ilike('relationship', escapeIlike(cleanRelationship))
      .limit(10);
    if (data?.length === 1) return { person: data[0], match: 'relationship' };
    if (data?.length > 1) return { person: null, ambiguous: true, candidates: data, match: 'relationship' };
  }

  if (cleanText(name)) {
    return decideNameMatch(await loadNameCandidates(supabase, userId, name), name);
  }
  return { person: null };
}

async function attachAddress(supabase, participantId, channelType, addressValue) {
  if (!addressValue) return;
  await supabase.from('participant_addresses').upsert({
    participant_id: participantId,
    channel_type: channelType,
    address_value: addressValue
  }, { onConflict: 'participant_id,channel_type,address_value', ignoreDuplicates: true });
}

// Read-then-write rather than an upsert: the dedupe index is on (participant_id,
// lower(fact)), and Postgres cannot target an expression index from an ON CONFLICT column
// list — an upsert here fails outright with "no unique or exclusion constraint matching".
// Case-insensitive dedupe is worth more than the round-trip saved.
async function replaceFacts(supabase, userId, participantId, { add = [], remove = [], kind = 'note', source = 'stated' }) {
  const { data: existing } = await supabase
    .from('person_facts').select('id, fact').eq('participant_id', participantId).eq('user_id', userId);
  let rows = existing || [];

  // Removal is substring-based on purpose: a correction arrives as "not silver", and the
  // stored fact is "prefers silver jewellery". Matching the whole string would never fire.
  if (remove.length) {
    const doomed = rows.filter(row => {
      const fact = row.fact.toLowerCase();
      return remove.some(term => fact.includes(term.toLowerCase()) || term.toLowerCase().includes(fact));
    });
    if (doomed.length) {
      await supabase.from('person_facts').delete().in('id', doomed.map(row => row.id));
      const gone = new Set(doomed.map(row => row.id));
      rows = rows.filter(row => !gone.has(row.id));
    }
  }

  for (const fact of add) {
    const match = rows.find(row => row.fact.toLowerCase() === fact.toLowerCase());
    if (match) {
      await supabase.from('person_facts')
        .update({ fact, kind, source, updated_at: new Date().toISOString() })
        .eq('id', match.id);
      continue;
    }
    if (rows.length >= MAX_FACTS_PER_PERSON) break;
    const { data: inserted } = await supabase.from('person_facts')
      .insert({ user_id: userId, participant_id: participantId, fact, kind, source })
      .select('id, fact').single();
    if (inserted) rows.push(inserted);
  }
}

// Captures or corrects a person. Returns { ambiguous, candidates } WITHOUT writing when the
// name matches more than one existing person and no handle disambiguates it — see rule 2.
async function upsertPerson(supabase, userId, {
  name, relationship, email, phone, facts, removeFacts, businessName, forceNew = false, source = 'manual', factKind = 'note'
} = {}) {
  const displayName = cleanText(name, 120);
  const cleanEmail = normalizeEmail(email);
  const cleanPhone = normalizePhone(phone);
  if (!displayName && !cleanEmail && !cleanPhone) {
    return { success: false, error: 'A name, email address or phone number is required.' };
  }

  let person = null;
  let created = false;
  if (!forceNew) {
    const resolved = await resolvePerson(supabase, userId, { name: displayName, email: cleanEmail, phone: cleanPhone });
    if (resolved.ambiguous) {
      return {
        success: false,
        ambiguous: true,
        candidates: resolved.candidates.map(p => ({ id: p.id, name: p.display_name, relationship: p.relationship })),
        error: `More than one person here is called "${displayName}".`
      };
    }
    person = resolved.person;
  }

  if (!person) {
    const { data, error } = await supabase.from('participants').insert({
      user_id: userId,
      display_name: displayName || cleanEmail || cleanPhone,
      business_name: cleanText(businessName, 120) || null,
      relationship: cleanText(relationship, 60) || null,
      source: source === 'learned' ? 'learned' : 'manual'
    }).select().single();
    if (error) return { success: false, error: error.message };
    person = data;
    created = true;
  } else {
    const patch = { updated_at: new Date().toISOString() };
    if (shouldReplaceDisplayName(person.display_name, displayName)) patch.display_name = displayName;
    if (relationship !== undefined && relationship !== null && cleanText(relationship, 60)) patch.relationship = cleanText(relationship, 60);
    if (cleanText(businessName, 120)) patch.business_name = cleanText(businessName, 120);
    const { data, error } = await supabase.from('participants').update(patch).eq('id', person.id).eq('user_id', userId).select().single();
    if (error) return { success: false, error: error.message };
    person = data;
  }

  await attachAddress(supabase, person.id, 'email', cleanEmail);
  await attachAddress(supabase, person.id, 'phone_sms', cleanPhone);

  const add = toFactList(facts);
  const remove = toFactList(removeFacts);
  if (add.length || remove.length) {
    await replaceFacts(supabase, userId, person.id, { add, remove, kind: factKind === 'preference' ? 'preference' : 'note' });
  }

  return { success: true, person, created, factsAdded: add.length, factsRemoved: remove.length };
}

async function loadProfiles(supabase, userId, people = []) {
  if (!people.length) return [];
  const ids = people.map(p => p.id);
  const [{ data: addresses }, { data: facts }, { data: occasions }] = await Promise.all([
    supabase.from('participant_addresses').select('participant_id, channel_type, address_value').in('participant_id', ids),
    supabase.from('person_facts').select('id, participant_id, fact, kind, source').in('participant_id', ids),
    supabase.from('occasions').select('participant_id, person_name, occasion_type, month, day').eq('user_id', userId)
  ]);

  return people.map(person => {
    const own = (addresses || []).filter(a => a.participant_id === person.id);
    return {
      id: person.id,
      name: person.display_name,
      businessName: person.business_name || null,
      relationship: person.relationship || null,
      source: person.source,
      emails: own.filter(a => a.channel_type === 'email').map(a => a.address_value),
      phones: own.filter(a => a.channel_type === 'phone_sms').map(a => a.address_value),
      facts: (facts || []).filter(f => f.participant_id === person.id)
        .map(f => ({ id: f.id, fact: f.fact, kind: f.kind, source: f.source })),
      // Linked by id where the occasion knows its person; falls back to the name for rows
      // saved before the link existed.
      occasions: (occasions || []).filter(o =>
        o.participant_id === person.id ||
        (!o.participant_id && cleanText(o.person_name).toLowerCase() === cleanText(person.display_name).toLowerCase())
      ).map(o => ({ occasionType: o.occasion_type, month: o.month, day: o.day }))
    };
  });
}

async function findPeople(supabase, userId, { query, relationship, email, phone, limit = 10 } = {}) {
  const cleanQuery = cleanText(query, 120);
  const cleanEmail = normalizeEmail(email || (cleanQuery.includes('@') ? cleanQuery : ''));
  const cleanPhone = normalizePhone(phone);

  if (cleanEmail || cleanPhone || relationship) {
    const resolved = await resolvePerson(supabase, userId, { email: cleanEmail, phone: cleanPhone, relationship, name: relationship ? '' : cleanQuery });
    if (resolved.ambiguous) return { ambiguous: true, profiles: await loadProfiles(supabase, userId, resolved.candidates) };
    if (resolved.person) return { profiles: await loadProfiles(supabase, userId, [resolved.person]) };
  }

  if (!cleanQuery) {
    const { data } = await supabase.from('participants').select('*').eq('user_id', userId)
      .order('updated_at', { ascending: false, nullsFirst: false }).limit(limit);
    return { profiles: await loadProfiles(supabase, userId, data || []) };
  }

  const candidates = await loadNameCandidates(supabase, userId, cleanQuery);
  const decided = decideNameMatch(candidates, cleanQuery);
  if (decided.person) return { profiles: await loadProfiles(supabase, userId, [decided.person]) };
  if (decided.ambiguous) return { ambiguous: true, profiles: await loadProfiles(supabase, userId, decided.candidates) };

  // Nothing matched by name — try relationship wording ("my manager") before giving up.
  const { data: byRelationship } = await supabase.from('participants').select('*').eq('user_id', userId)
    .ilike('relationship', `%${escapeIlike(cleanQuery)}%`).limit(limit);
  return { profiles: await loadProfiles(supabase, userId, byRelationship || []) };
}

// "Ben isn't my manager anymore", "forget that preference", "delete Ben". Never a blanket
// wipe: the caller has to say which of the three it means.
async function forgetPersonDetail(supabase, userId, { participantId, facts, clearRelationship = false, deletePerson = false } = {}) {
  if (!participantId) return { success: false, error: 'A person is required.' };
  const { data: person } = await supabase.from('participants').select('*').eq('id', participantId).eq('user_id', userId).maybeSingle();
  if (!person) return { success: false, error: 'not_found' };

  if (deletePerson) {
    await supabase.from('participants').delete().eq('id', participantId).eq('user_id', userId);
    return { success: true, deleted: true, person };
  }

  const remove = toFactList(facts);
  if (remove.length) await replaceFacts(supabase, userId, participantId, { add: [], remove });
  if (clearRelationship) {
    await supabase.from('participants').update({ relationship: null, updated_at: new Date().toISOString() })
      .eq('id', participantId).eq('user_id', userId);
  }
  return { success: true, factsRemoved: remove.length, relationshipCleared: clearRelationship, person };
}

// ── Formatting ─────────────────────────────────────────────────────────────────────────

function formatProfile(profile) {
  const parts = [profile.name];
  if (profile.relationship) parts.push(`your ${profile.relationship}`);
  if (profile.businessName) parts.push(profile.businessName);
  const contact = [...profile.emails, ...profile.phones].slice(0, 2);
  if (contact.length) parts.push(contact.join(', '));
  const facts = profile.facts.map(f => f.fact).slice(0, 4);
  if (facts.length) parts.push(facts.join('; '));
  return parts.join(' — ');
}

function formatPeopleSummary(profiles = [], { ambiguous = false, query = '' } = {}) {
  if (!profiles.length) {
    return query ? `I don't have anyone saved as "${query}".` : "I don't have anyone saved yet.";
  }
  if (ambiguous) {
    return `More than one person matches${query ? ` "${query}"` : ''}: ${profiles.map(formatProfile).join(' | ')}. Which one?`;
  }
  return profiles.map(formatProfile).join('. ');
}

// A compact roster for the live system-prompt context, so "email my manager" and "her"
// resolve without a tool call. Names and relationships only — the notes/preferences stay
// behind an explicit lookup rather than being pasted into every single request.
function peopleContextLine(people = [], { max = 12 } = {}) {
  const lines = people
    .filter(p => p?.display_name)
    .slice(0, max)
    .map(p => (p.relationship ? `${p.display_name} (${p.relationship})` : p.display_name));
  return lines.join(', ');
}

module.exports = {
  MAX_FACTS_PER_PERSON,
  normalizeEmail,
  normalizePhone,
  rankNameCandidates,
  decideNameMatch,
  shouldReplaceDisplayName,
  resolvePerson,
  upsertPerson,
  findPeople,
  forgetPersonDetail,
  loadProfiles,
  formatProfile,
  formatPeopleSummary,
  peopleContextLine
};
