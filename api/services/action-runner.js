const {
  applyActionContractResultMetadata,
  buildActionRecovery,
  getActionContract,
  validateActionWithContract
} = require('../action-contracts');
const { diagnoseConnectorIssue } = require('./connector-health');
const { buildPendingReviewResult } = require('./pending-review');

function createActionRunner({
  executeAction,
  invalidateUserContextCache = () => {},
  logAction = async () => {},
  setPendingAction,
  validateAction = validateActionWithContract
}) {
  if (typeof executeAction !== 'function') {
    throw new TypeError('createActionRunner requires executeAction');
  }
  if (typeof setPendingAction !== 'function') {
    throw new TypeError('createActionRunner requires setPendingAction');
  }

  return async function executeActions(userId, actions, context = {}, trace = null, callbacks = {}) {
    if (!actions?.length) return [];
    const results = await Promise.all(actions.map(async action => {
      if (callbacks.onActionStart) callbacks.onActionStart(action);
      const validationError = validateAction(action, context.userMessage || '');
      const contract = getActionContract(action.type);
      let result;

      if (validationError) {
        result = applyActionContractResultMetadata(action, validationError);
      } else if (contract?.executionMode === 'review' && !context.bypassReview) {
        await setPendingAction(userId, action, context);
        result = buildPendingReviewResult(action);
      } else {
        result = trace
          ? await trace.run(`action.${action.type}.execute`, () => executeAction(userId, action.type, action.input || {}, context))
          : await executeAction(userId, action.type, action.input || {}, context);
        Object.assign(result, buildActionRecovery(action, result));
        Object.assign(result, diagnoseConnectorIssue(action, result));
        result = applyActionContractResultMetadata(action, result);
      }

      const log = () => logAction(userId, action, result);
      if (trace) {
        await trace.run(`action_log.insert.${action.type}`, log).catch(err =>
          console.warn('[action-runner] log failed:', err.message)
        );
      } else {
        await log().catch(err => console.warn('[action-runner] log failed:', err.message));
      }
      if (callbacks.onActionComplete) callbacks.onActionComplete(action, result);
      return { action: action.type, result };
    }));
    invalidateUserContextCache(userId);
    return results;
  };
}

module.exports = { createActionRunner };
