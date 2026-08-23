// Backwards-compatible name for the execution boundary. The policy pipeline lives once in
// action-execution.js; older callers can keep their existing import while migrating.
// Review gate source of truth remains: contract?.executionMode === 'review' || context.guardMode.
const { createActionExecution } = require('./action-execution');

function createActionRunner(options = {}) {
  // The old test/dev seam accepted an executeAction callback. Keep that callback as an
  // adapter invoker only; registration still comes from the contract/resolver and there is
  // no bypass flag for unknown actions.
  const { executeAction, ...rest } = options;
  const invokeAdapter = rest.invokeAdapter || (typeof executeAction === 'function'
    ? ({ userId, type, input, context }) => executeAction(userId, type, input, context)
    : null);
  return createActionExecution({ ...rest, invokeAdapter });
}

module.exports = { createActionRunner };
