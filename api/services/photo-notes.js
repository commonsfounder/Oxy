'use strict';

// Short notes the phone wrote about the user's own photos. The pictures never leave the phone;
// only these lines do. Stored as memories with source 'photos' so export and deletion cover them.

const SOURCE = 'photos';
const ACTION_SOURCE = 'photo_action';
const MAX_BATCH = 40;
const MAX_NOTE = 420;
const MAX_STORED = 300;

// Long digit runs (cards, account and phone numbers) are blanked before anything is stored.
function redact(text) {
  return String(text || '').replace(/\d(?:[\s-]?\d){7,}/g, '[number]');
}

function noteLine(note) {
  const text = redact(String(note?.text || '').replace(/\s+/g, ' ').trim()).slice(0, MAX_NOTE);
  if (Array.from(text).filter(ch => /\p{L}/u.test(ch)).length < 6) return '';
  const when = Date.parse(note?.date || '');
  const day = Number.isFinite(when) ? new Date(when).toISOString().slice(0, 10) : '';
  return day ? `Photo from ${day}: ${text}` : `Photo: ${text}`;
}

async function saveNotes(supabase, userId, notes = [], now = new Date()) {
  const lines = [...new Set((Array.isArray(notes) ? notes : []).slice(0, MAX_BATCH).map(noteLine).filter(Boolean))];
  if (!lines.length) return { saved: 0 };
  const { data: existing } = await supabase.from('memories').select('content').eq('user_id', userId).eq('source', SOURCE).in('content', lines);
  const have = new Set((existing || []).map(row => row.content));
  const fresh = lines.filter(line => !have.has(line));
  if (fresh.length) {
    const { error } = await supabase.from('memories').insert(fresh.map(content => ({ user_id: userId, content, source: SOURCE, created_at: now.toISOString() })));
    if (error) throw error;
    await trim(supabase, userId);
  }
  return { saved: fresh.length };
}

// Oldest notes go first once the cap is passed.
async function trim(supabase, userId) {
  const { data } = await supabase.from('memories').select('id').eq('user_id', userId).eq('source', SOURCE).order('created_at', { ascending: false }).range(MAX_STORED, MAX_STORED + 500);
  const ids = (data || []).map(row => row.id);
  if (ids.length) await supabase.from('memories').delete().in('id', ids);
}

async function search(supabase, userId, query = '', limit = 8) {
  const words = [...new Set(String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2))].slice(0, 6);
  const { data, error } = await supabase.from('memories').select('content, created_at').eq('user_id', userId).eq('source', SOURCE).order('created_at', { ascending: false }).limit(300);
  if (error) throw error;
  const scored = (data || []).map(row => ({ content: row.content, score: words.filter(w => row.content.toLowerCase().includes(w)).length }));
  return (words.length ? scored.filter(r => r.score > 0).sort((a, b) => b.score - a.score) : scored).slice(0, limit).map(r => r.content);
}

// What a photo suggests doing ("add this flyer to the calendar"), kept for every photo so Home can
// surface it later. Stored as a hidden memory, so export and deletion already cover it.
async function saveAction(supabase, userId, { id, ask, prompt, date }, now = new Date()) {
  if (!id || !ask || !prompt) return false;
  const content = JSON.stringify({ id, ask, prompt, date: date || null });
  const { data: existing } = await supabase.from('memories').select('content').eq('user_id', userId).eq('source', ACTION_SOURCE).in('content', [content]);
  if (existing?.length) return false;
  const { error } = await supabase.from('memories').insert({ user_id: userId, content, source: ACTION_SOURCE, created_at: now.toISOString() });
  if (error) throw error;
  return true;
}

async function listActions(supabase, userId, { sinceDays = 45, now = new Date(), limit = 40 } = {}) {
  const { data } = await supabase.from('memories').select('content').eq('user_id', userId).eq('source', ACTION_SOURCE).order('created_at', { ascending: false }).limit(200);
  const cutoff = now.getTime() - sinceDays * 86400000;
  const out = [];
  for (const row of data || []) {
    try {
      const item = JSON.parse(row.content);
      const taken = Date.parse(item.date || '');
      if (item.id && item.ask && item.prompt && (!Number.isFinite(taken) || taken >= cutoff)) out.push({ id: item.id, ask: item.ask, prompt: item.prompt });
    } catch { /* skip a row that is not ours */ }
    if (out.length >= limit) break;
  }
  return out;
}

async function forgetAll(supabase, userId) {
  const { error } = await supabase.from('memories').delete().eq('user_id', userId).in('source', [SOURCE, ACTION_SOURCE]);
  if (error) throw error;
}

module.exports = { SOURCE, ACTION_SOURCE, redact, noteLine, saveNotes, saveAction, listActions, search, forgetAll };
