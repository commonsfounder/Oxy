'use strict';

// A bounded, read-only battery for the user's "do all of that" request. It deliberately
// composes existing actions instead of reaching into connectors itself, so connection
// availability, redaction, receipts, and failure wording stay owned by the canonical
// action layer. No message, booking, payment, calendar write, credential use, or device
// command belongs in this list.
const DEFAULT_READS = Object.freeze([
  Object.freeze({ action: 'daily_digest', input: Object.freeze({ focus: 'all' }) }),
  Object.freeze({ action: 'get_emails', input: Object.freeze({ max_results: 20 }) }),
  Object.freeze({ action: 'get_calendar_events', input: Object.freeze({}) }),
  Object.freeze({ action: 'find_reply_needed', input: Object.freeze({ max_threads: 15 }) }),
  Object.freeze({ action: 'find_occasions', input: Object.freeze({}) }),
  Object.freeze({ action: 'find_commitments', input: Object.freeze({}) }),
  Object.freeze({ action: 'list_responsibilities', input: Object.freeze({}) }),
  Object.freeze({ action: 'list_scheduled_tasks', input: Object.freeze({}) }),
  Object.freeze({ action: 'list_paired_displays', input: Object.freeze({}) })
]);

const OPTIONAL_READS = Object.freeze([
  Object.freeze({ key: 'weather', inputKey: 'weather_city', action: 'get_weather', build: value => ({ city: value }), requires: ['weather_city'] }),
  Object.freeze({ key: 'place', inputKey: 'place_query', action: 'find_place', build: value => ({ query: value }), requires: ['place_query'] }),
  Object.freeze({
    key: 'directions',
    inputKey: 'directions_destination',
    action: 'get_directions',
    build: (value, inputs) => ({ destination: value, ...(inputs.directions_origin ? { origin: inputs.directions_origin } : {}) }),
    requires: ['directions_destination']
  }),
  Object.freeze({
    key: 'travel',
    inputKey: 'train_origin',
    action: 'search_trains',
    build: (value, inputs) => ({ origin: value, destination: inputs.train_destination, ...(inputs.train_date ? { date: inputs.train_date } : {}) }),
    requires: ['train_origin', 'train_destination']
  }),
  Object.freeze({
    key: 'flights',
    inputKey: 'flight_from',
    action: 'search_flights',
    build: (value, inputs) => ({ from: value, to: inputs.flight_to, ...(inputs.flight_depart_date ? { depart_date: inputs.flight_depart_date } : {}), ...(inputs.flight_return_date ? { return_date: inputs.flight_return_date } : {}) }),
    requires: ['flight_from', 'flight_to']
  }),
  Object.freeze({
    key: 'hotels',
    inputKey: 'hotel_location',
    action: 'search_hotels',
    build: (value, inputs) => ({ location: value, ...(inputs.hotel_check_in ? { check_in: inputs.hotel_check_in } : {}), ...(inputs.hotel_check_out ? { check_out: inputs.hotel_check_out } : {}) }),
    requires: ['hotel_location']
  }),
  Object.freeze({ key: 'stock', inputKey: 'stock_symbol', action: 'get_stock_price', build: value => ({ symbol: value }), requires: ['stock_symbol'] }),
  Object.freeze({ key: 'amazon', inputKey: 'amazon_query', action: 'search_amazon', build: value => ({ query: value }), requires: ['amazon_query'] }),
  Object.freeze({ key: 'itinerary', inputKey: 'itinerary_destination', action: 'plan_itinerary', build: (value, inputs) => ({ destination: value, ...(inputs.itinerary_start_date ? { start_date: inputs.itinerary_start_date } : {}), ...(inputs.itinerary_duration_days ? { duration_days: inputs.itinerary_duration_days } : {}) }), requires: ['itinerary_destination'] }),
  Object.freeze({ key: 'google_docs', inputKey: 'google_docs_query', action: 'search_google_docs', build: value => ({ query: value, max_results: 20 }), requires: ['google_docs_query'] }),
  Object.freeze({ key: 'github', inputKey: 'github_repo', action: 'get_github_prs', build: value => ({ repo: value }), requires: ['github_repo'] })
]);

const SIDE_EFFECTS_NOT_RUN = Object.freeze([
  'send_message',
  'send_email',
  'send_millie_email',
  'send_millie_sms',
  'send_telegram',
  'create_calendar_event',
  'move_calendar_event',
  'cancel_calendar_event',
  'create_reminder',
  'schedule_block',
  'book_appointment',
  'run_browser_task',
  'confirm_browser_payment',
  'control_smart_home',
  'make_call',
  'stripe_charge',
  'spend_from_concierge_account',
  'project_write',
  'project_commit',
  'project_sync',
  'create_github_issue'
]);

function cleanInputs(inputs) {
  return inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs : {};
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function isCompleted(result) {
  return result?.success === true && !['failed', 'unavailable', 'incomplete', 'awaiting_user', 'handoff_required'].includes(result?.outcome);
}

async function runCapabilitySweep({ userId, inputs = {}, execute }) {
  if (!hasValue(userId)) throw new TypeError('runCapabilitySweep requires userId');
  if (typeof execute !== 'function') throw new TypeError('runCapabilitySweep requires execute');

  const normalizedInputs = cleanInputs(inputs);
  const plan = DEFAULT_READS.map(item => ({ action: item.action, input: { ...item.input } }));
  const skipped = [];

  for (const optional of OPTIONAL_READS) {
    const ready = optional.requires.every(key => hasValue(normalizedInputs[key]));
    if (!ready) {
      skipped.push({ key: optional.key, action: optional.action, requires: optional.requires, reason: 'No target supplied; no search was invented.' });
      continue;
    }
    plan.push({ action: optional.action, input: optional.build(normalizedInputs[optional.inputKey], normalizedInputs) });
  }

  const results = [];
  for (const item of plan) {
    let result;
    try {
      result = await execute(item.action, item.input);
    } catch (error) {
      result = { success: false, outcome: 'failed', error: error?.message || String(error) };
    }
    results.push({ action: item.action, input: item.input, result });
  }

  const completed = results.filter(item => isCompleted(item.result)).length;
  const failed = results.length - completed;
  const outcome = failed ? 'incomplete' : 'completed';
  return {
    success: failed === 0,
    outcome,
    actionSummary: failed ? `Read-only sweep finished with ${failed} unavailable or failed check${failed === 1 ? '' : 's'}.` : `Read-only sweep finished: ${completed} checks completed.`,
    text: failed ? 'The read-only sweep finished, but some sources were unavailable. See each result and skipped target.' : 'The read-only sweep finished.',
    results,
    skipped,
    notRun: SIDE_EFFECTS_NOT_RUN,
    coverage: { total: results.length, completed, failed, skipped: skipped.length }
  };
}

module.exports = { DEFAULT_READS, OPTIONAL_READS, SIDE_EFFECTS_NOT_RUN, runCapabilitySweep };
