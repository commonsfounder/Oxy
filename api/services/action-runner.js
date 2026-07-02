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

    const sequential = !!context.sequential || !!context.agentIteration; // agent loops often want order + result chaining
    const previousResults = context.previousResults || [];

    // Inject previous results into input for dependent actions (simple data passing for agentic flows)
    const enrichedActions = actions.map((action, idx) => {
      let input = { ...(action.input || {}) };
      if (previousResults.length) {
        // naive but effective: expose last successful result data under _prev
        const last = previousResults[previousResults.length - 1];
        if (last && last.result) input._prev = last.result;
        input._allPrev = previousResults.map(r => ({ type: r.action, result: r.result }));
      }
      return { ...action, input };
    });

    if (!sequential) {
      const results = await Promise.all(enrichedActions.map(async action => {
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
          await trace.run(`action_log.insert.${action.type}`, log);
        } else {
          await log();
        }
        if (callbacks.onActionComplete) callbacks.onActionComplete(action, result);
        return { action: action.type, result, input: action.input };
      }));
      invalidateUserContextCache(userId);
      return results;
    }

    // Sequential execution with result chaining (key for agentic multi-step)
    const results = [];
    for (const action of enrichedActions) {
      if (callbacks.onActionStart) callbacks.onActionStart(action);
      const validationError = validateAction(action, context.userMessage || '');
      const contract = getActionContract(action.type);
      let result;

      if (validationError) {
        result = applyActionContractResultMetadata(action, validationError);
      } else if (contract?.executionMode === 'review' && !context.bypassReview) {
        await setPendingAction(userId, action, context);
        result = buildPendingReviewResult(action);
      } else if (context.dryRun || context.simulate) {
        // Simulation / sandbox mode: do not execute for real. Great for agent preview.
        result = {
          success: true,
          simulated: true,
          text: `[SIMULATED] Would execute ${action.type} with ${JSON.stringify(action.input || {})}`,
          actionSummary: 'Simulated (no real side effects)'
        };
      } else {
        const execContext = { ...context, previousResults: results };
        result = trace
          ? await trace.run(`action.${action.type}.execute`, () => executeAction(userId, action.type, action.input || {}, execContext))
          : await executeAction(userId, action.type, action.input || {}, execContext);
        Object.assign(result, buildActionRecovery(action, result));
        Object.assign(result, diagnoseConnectorIssue(action, result));
        result = applyActionContractResultMetadata(action, result);
      }

      const log = () => logAction(userId, action, result);
      if (trace) {
        await trace.run(`action_log.insert.${action.type}`, log);
      } else {
        await log();
      }
      if (callbacks.onActionComplete) callbacks.onActionComplete(action, result);
      const entry = { action: action.type, result, input: action.input };
      results.push(entry);
    }
    invalidateUserContextCache(userId);
    return results;
  };
}

module.exports = { createActionRunner };
