/** Plain-English descriptions of logged actions, for the activity history. */

const { ACTION_WORDING } = require('../action-wording');

const INTERNAL_PREFIXES = ['workspace_', 'project_'];
const INTERNAL_TYPES = new Set([
  'simulate_actions', 'record_watch_observation', 'list_scheduled_tasks', 'list_responsibilities',
  'list_paired_displays', 'get_display_scene', 'find_commitments', 'find_people', 'find_occasions',
  'find_spend', 'track_commitment', 'calculate'
]);

const DESCRIBERS = Object.fromEntries(
  Object.entries(ACTION_WORDING).filter(([, wording]) => wording.summary).map(([type, wording]) => [type, wording.summary])
);

function humanize(type) {
  const spaced = String(type || 'unknown').replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * @param {object|string|null} action  the logged action (type plus its parameters)
 * @param {object} [contract]          the matching ACTION_CONTRACTS entry, if any
 * @returns {{summary: string, kind: 'looked'|'did'|'sent'|'spent'|'other', usedLocation: boolean, hidden: boolean}}
 */
function describeAction(action, contract = {}) {
  const type = String(action?.type || 'unknown');
  const params = action?.params || action?.input || action?.args || action || {};
  const hidden = INTERNAL_TYPES.has(type) || INTERNAL_PREFIXES.some((prefix) => type.startsWith(prefix));

  const describer = DESCRIBERS[type];
  if (describer) {
    const out = describer(params);
    return { summary: out.summary, kind: out.kind || 'other', usedLocation: out.usedLocation === true, hidden };
  }

  const fallback = contract.successSummary ? String(contract.successSummary) : humanize(type);
  const kind = contract.risk === 'low' && !contract.executionMode ? 'looked' : 'other';
  return { summary: fallback, kind, usedLocation: false, hidden };
}

module.exports = { describeAction };
