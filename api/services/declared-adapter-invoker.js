const UNAVAILABLE_ERROR = 'That capability is not available yet. No action was taken.';
const DISABLED_ERROR = 'This connection is disabled. Re-enable it in Settings before trying again.';

function createDeclaredAdapterInvoker({
  executeInline,
  dispatchConnector,
  getEnabledConnectors = async () => []
}) {
  if (typeof executeInline !== 'function') throw new TypeError('createDeclaredAdapterInvoker requires executeInline');
  if (typeof dispatchConnector !== 'function') throw new TypeError('createDeclaredAdapterInvoker requires dispatchConnector');

  return async function invokeDeclaredAdapter({ adapter, userId, type, input, context = {} }) {
    const enrichedInput = {
      ...(input || {}),
      ...(context.location ? { location: context.location } : {}),
      ...(context.homeLocation ? { homeLocation: context.homeLocation } : {})
    };

    if (adapter?.kind === 'inline') {
      return executeInline({ userId, type, input: enrichedInput, context });
    }

    if (adapter?.kind === 'connector') {
      if (adapter.requiresConnection === true) {
        const enabledConnectors = Array.isArray(context.enabledConnectors)
          ? context.enabledConnectors
          : await getEnabledConnectors(userId, context.trace || null);
        if (!enabledConnectors.includes(adapter.id)) {
          return { success: false, outcome: 'unavailable', unavailable: true, error: DISABLED_ERROR };
        }
      }
      return dispatchConnector({ connectorId: adapter.id, userId, type, input: enrichedInput, context });
    }

    return { success: false, outcome: 'unavailable', unavailable: true, error: UNAVAILABLE_ERROR };
  };
}

module.exports = {
  createDeclaredAdapterInvoker,
  UNAVAILABLE_ERROR,
  DISABLED_ERROR
};
