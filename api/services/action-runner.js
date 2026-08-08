const {
  applyActionContractResultMetadata,
  buildActionRecovery,
  getActionContract,
  validateActionWithContract
} = require('../action-contracts');
const { diagnoseConnectorIssue } = require('./connector-health');
const { buildPendingReviewResult, MONEY_ACTION_TYPES } = require('./pending-review');

// Logging an already-computed action result is an audit/analytics concern, never the
// security enforcement itself (that's the review-gate check above, independent of this) —
// so a failure here must never affect the action's own result or crash the batch it's part
// of. This used to be inlined per call site as `await log().catch(...)`, which assumed
// `log()` always returns a real Promise. It doesn't: `logAction` in production is wired to
// `supabase.from('action_log').insert(...)`, and Supabase's query builder is a thenable
// (has `.then`) but does NOT implement `.catch` as an own method, so `log().catch` was
// `undefined` and calling it threw a synchronous TypeError — before `await` ever ran. That
// throw wasn't caught by anything in the sequential loop, so it escaped `executeActions`
// entirely; callers (agent-orchestrator.js) then mapped the WHOLE batch for that iteration
// to a failure, including actions that had already executed successfully. A plain
// try/await/catch here (instead of chaining `.catch` on the callback's return value) works
// for a real Promise, a Supabase-style thenable, or a callback that throws synchronously —
// and swallowing the error via console.warn is what "non-fatal" means in practice, matching
// what the old `.catch(err => console.warn(...))` was already trying (and failing) to do.
async function safeLogAction(trace, label, fn) {
  try {
    if (trace) {
      await trace.run(label, fn);
    } else {
      await fn();
    }
  } catch (err) {
    console.warn('[action-runner] log failed:', err?.message || err);
  }
}

function createActionRunner({
  executeAction,
  invalidateUserContextCache = () => {},
  logAction = async () => {},
  setPendingAction,
  validateAction = validateActionWithContract,
  getLinkedCardInfo = async () => null
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
        } else if ((contract?.executionMode === 'review' || context.guardMode) && !context.bypassReview) {
          await setPendingAction(userId, action, context);
          const cardInfo = MONEY_ACTION_TYPES.has(action.type) ? await getLinkedCardInfo(userId) : null;
          result = buildPendingReviewResult(action, cardInfo);
        } else {
          result = trace
            ? await trace.run(`action.${action.type}.execute`, () => executeAction(userId, action.type, action.input || {}, context))
            : await executeAction(userId, action.type, action.input || {}, context);
          Object.assign(result, buildActionRecovery(action, result));
          Object.assign(result, diagnoseConnectorIssue(action, result));
          result = applyActionContractResultMetadata(action, result);
        }

        await safeLogAction(trace, `action_log.insert.${action.type}`, () => logAction(userId, action, result));
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
      } else if ((contract?.executionMode === 'review' || context.guardMode) && !context.bypassReview) {
        await setPendingAction(userId, action, context);
        const cardInfo = MONEY_ACTION_TYPES.has(action.type) ? await getLinkedCardInfo(userId) : null;
        result = buildPendingReviewResult(action, cardInfo);
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
        try {
          result = trace
            ? await trace.run(`action.${action.type}.execute`, () => executeAction(userId, action.type, action.input || {}, execContext))
            : await executeAction(userId, action.type, action.input || {}, execContext);
          Object.assign(result, buildActionRecovery(action, result));
          Object.assign(result, diagnoseConnectorIssue(action, result));
          result = applyActionContractResultMetadata(action, result);
        } catch (e) {
          // Isolate this action's failure so a throw here doesn't discard the
          // results already collected for actions earlier in the batch.
          result = { success: false, error: e.message };
        }
      }

      await safeLogAction(trace, `action_log.insert.${action.type}`, () => logAction(userId, action, result));
      if (callbacks.onActionComplete) callbacks.onActionComplete(action, result);
      const entry = { action: action.type, result, input: action.input };
      results.push(entry);
    }
    invalidateUserContextCache(userId);
    return results;
  };
}

module.exports = { createActionRunner };
