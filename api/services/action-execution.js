const {
  applyActionContractResultMetadata,
  buildActionRecovery,
  getActionContract,
  validateActionWithContract
} = require('../action-contracts');
const { adapterForAction } = require('./action-catalog');
const { diagnoseConnectorIssue } = require('./connector-health');
const { buildPendingReviewResult, MONEY_ACTION_TYPES } = require('./pending-review');
const { normalizeActionOutcome } = require('./action-outcome');

function simulatedActionResult(action) {
  return {
    success: false,
    outcome: 'simulated',
    simulated: true,
    text: `[SIMULATED] Would execute ${action.type} with ${JSON.stringify(action.input || {})}`,
    actionSummary: 'Simulated (no real side effects)'
  };
}

function unavailableActionResult(type) {
  return {
    success: false,
    outcome: 'unavailable',
    unavailable: true,
    error: 'That capability is not available yet. No action was taken.'
  };
}

async function safeLogAction(trace, label, fn) {
  try {
    if (trace) await trace.run(label, fn);
    else await fn();
  } catch (err) {
    console.warn('[action-execution] log failed:', err?.message || err);
  }
}

function createActionExecution({
  invokeAdapter,
  invalidateUserContextCache = () => {},
  logAction = async () => {},
  setPendingAction,
  validateAction = validateActionWithContract,
  getLinkedCardInfo = async () => null,
  resolveAdapter = adapterForAction,
  resolveContract = getActionContract
}) {
  if (typeof invokeAdapter !== 'function') throw new TypeError('createActionExecution requires invokeAdapter');
  if (typeof setPendingAction !== 'function') throw new TypeError('createActionExecution requires setPendingAction');

  async function executeOne(userId, action, context, trace, previousResults = []) {
    const type = action?.type || '';
    const contract = resolveContract(type);
    const adapter = resolveAdapter(type, contract);
    let result;

    if (!contract || !adapter) {
      result = unavailableActionResult(type);
    } else {
      const validationError = validateAction(action, context.userMessage || '');
      if (validationError) {
        result = applyActionContractResultMetadata(action, validationError);
      } else if (context.dryRun || context.simulate) {
        result = simulatedActionResult(action);
      } else if ((contract?.executionMode === 'review' || context.guardMode) && !context.bypassReview) {
        await setPendingAction(userId, action, context);
        const cardInfo = MONEY_ACTION_TYPES.has(type) ? await getLinkedCardInfo(userId) : null;
        result = buildPendingReviewResult(action, cardInfo);
      } else {
        const execContext = previousResults.length ? { ...context, previousResults } : context;
        try {
          result = trace
            ? await trace.run(`action.${type}.execute`, () => invokeAdapter({ adapter, userId, type, input: action.input || {}, context: execContext }))
            : await invokeAdapter({ adapter, userId, type, input: action.input || {}, context: execContext });
          Object.assign(result, buildActionRecovery(action, result));
          Object.assign(result, diagnoseConnectorIssue(action, result));
          result = applyActionContractResultMetadata(action, result);
        } catch (error) {
          // An adapter failure belongs to this action; it must not erase prior batch results.
          result = { success: false, error: error?.message || String(error) };
          Object.assign(result, buildActionRecovery(action, result));
          Object.assign(result, diagnoseConnectorIssue(action, result));
          result = applyActionContractResultMetadata(action, result);
        }
      }
    }

    result = normalizeActionOutcome(result);
    await safeLogAction(trace, `action_log.insert.${type || 'unknown'}`, () => logAction(userId, action, result));
    return { action: type, result, input: action?.input || {} };
  }

  return async function executeActions(userId, actions, context = {}, trace = null, callbacks = {}) {
    if (!actions?.length) return [];
    // Delegation changes ownership of the whole goal, so it must never share a
    // parallel batch with sibling effects that would outlive the handoff.
    const sequential = !!context.sequential || !!context.agentIteration || actions.some(action => action?.type === 'create_agent_task');
    const previousResults = context.previousResults || [];
    const enrichedActions = actions.map(action => {
      const input = { ...(action.input || {}) };
      if (previousResults.length) {
        const last = previousResults[previousResults.length - 1];
        if (last?.result) input._prev = last.result;
        input._allPrev = previousResults.map(item => ({ type: item.action, result: item.result }));
      }
      return { ...action, input };
    });

    const run = async (action, prior) => {
      callbacks.onActionStart?.(action);
      const entry = await executeOne(userId, action, { ...context, ...(sequential && prior ? { previousResults: prior } : {}) }, trace, prior);
      callbacks.onActionComplete?.(action, entry.result);
      return entry;
    };

    let results;
    if (sequential) {
      results = [];
      for (const action of enrichedActions) {
        const entry = await run(action, results);
        results.push(entry);
        // A durable delegation owns the rest of the goal. Do not execute sibling
        // model calls in the foreground after handing it to the background queue.
        if (entry.result?.delegatedTask === true) break;
      }
    } else {
      results = await Promise.all(enrichedActions.map(action => run(action, [])));
    }
    invalidateUserContextCache(userId);
    return results;
  };
}

module.exports = { createActionExecution, unavailableActionResult };
