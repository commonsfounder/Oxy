// The result of an action is also a user-facing claim. Keep the vocabulary small and
// derive the legacy `success` flag from it so a handoff, simulation, or pending review
// can never be rendered as a completed side effect.

const ACTION_OUTCOMES = Object.freeze([
  'completed',
  'handoff_required',
  'awaiting_user',
  'simulated',
  'unavailable',
  'failed',
  'incomplete'
]);

const ACTION_OUTCOME_SET = new Set(ACTION_OUTCOMES);

function inferActionOutcome(result = {}) {
  if (ACTION_OUTCOME_SET.has(result.outcome)) return result.outcome;
  if (result.pending === true || result.requiresAction === true) return 'awaiting_user';
  if (result.simulated === true || result.simulation === true) return 'simulated';
  if (result.unavailable === true) return 'unavailable';
  if (result.incomplete === true || result.continuesBrowsing === true) return 'incomplete';
  if (result.success === false || result.error) return 'failed';
  // Handoffs must be marked by the action implementation. Links and native execution
  // hints can accompany a grounded completed result (for example a place card or route).
  if (result.handoffRequired === true) {
    return 'handoff_required';
  }
  if (result.success === true) return 'completed';
  return 'failed';
}

function normalizeActionOutcome(result = {}, overrides = {}) {
  const outcome = overrides.outcome || inferActionOutcome(result);
  const normalized = { ...result, outcome };
  // Preserve the old field for existing clients, but make it a strict compatibility view.
  normalized.success = outcome === 'completed';
  if (outcome === 'awaiting_user') normalized.pending = true;
  if (outcome === 'simulated') normalized.simulated = true;
  if (outcome === 'unavailable') normalized.unavailable = true;
  if (outcome === 'incomplete') normalized.incomplete = true;
  return normalized;
}

module.exports = {
  ACTION_OUTCOMES,
  inferActionOutcome,
  normalizeActionOutcome
};
