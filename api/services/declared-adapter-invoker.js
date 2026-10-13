const UNAVAILABLE_ERROR = 'That capability is not available yet. No action was taken.';
const { humanConnectorName } = require('./connector-health');

// Most people who hit this have never connected the service, so "re-enable" sent them looking
// for a switch that was never there. Name the service and the step.
function notConnectedError(connectorId) {
  return `${humanConnectorName(connectorId)} is not connected. Connect it in Settings to use this.`;
}

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
          return { success: false, outcome: 'unavailable', unavailable: true, notConnected: true, error: notConnectedError(adapter.id) };
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
  notConnectedError
};
