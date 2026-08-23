const path = require('node:path');
const {
  ACTION_CONTRACTS,
  getActionContract,
  actionToFunctionDeclaration
} = require('../action-contracts');

// This is the canonical execution manifest. It contains only lazy module paths and
// connection policy; action ownership still lives on each contract's explicit adapter.
// Importing this file never imports a connector or needs runtime credentials.
const CONNECTOR_DEFINITIONS = Object.freeze({
  google: { id: 'google', modulePath: path.resolve(__dirname, '../../connectors/google.js'), requiresConnection: true },
  microsoft: { id: 'microsoft', modulePath: path.resolve(__dirname, '../../connectors/microsoft.js'), requiresConnection: true },
  uber: { id: 'uber', modulePath: path.resolve(__dirname, '../../connectors/uber.js'), requiresConnection: false },
  telegram: { id: 'telegram', modulePath: path.resolve(__dirname, '../../connectors/telegram.js'), requiresConnection: true },
  trainline: { id: 'trainline', modulePath: path.resolve(__dirname, '../../connectors/trainline.js'), requiresConnection: false },
  maps: { id: 'maps', modulePath: path.resolve(__dirname, '../../connectors/maps.js'), requiresConnection: false },
  notion: { id: 'notion', modulePath: path.resolve(__dirname, '../../connectors/notion.js'), requiresConnection: true },
  github: { id: 'github', modulePath: path.resolve(__dirname, '../../connectors/github.js'), requiresConnection: true },
  stripe: { id: 'stripe', modulePath: path.resolve(__dirname, '../../connectors/stripe.js'), requiresConnection: true },
  weather: { id: 'weather', modulePath: path.resolve(__dirname, '../../connectors/weather.js'), requiresConnection: false },
  amazon: { id: 'amazon', modulePath: path.resolve(__dirname, '../../connectors/amazon.js'), requiresConnection: false },
  slack: { id: 'slack', modulePath: path.resolve(__dirname, '../../connectors/slack.js'), requiresConnection: true },
  lyft: { id: 'lyft', modulePath: path.resolve(__dirname, '../../connectors/lyft.js'), requiresConnection: false },
  strava: { id: 'strava', modulePath: path.resolve(__dirname, '../../connectors/strava.js'), requiresConnection: true },
  oura: { id: 'oura', modulePath: path.resolve(__dirname, '../../connectors/oura.js'), requiresConnection: true },
  flights: { id: 'flights', modulePath: path.resolve(__dirname, '../../connectors/flights.js'), requiresConnection: false },
  stocks: { id: 'stocks', modulePath: path.resolve(__dirname, '../../connectors/stocks.js'), requiresConnection: false }
});

const CONNECTOR_IDS = Object.freeze(Object.keys(CONNECTOR_DEFINITIONS));
const CONNECTOR_MODULES = Object.freeze(Object.fromEntries(
  CONNECTOR_IDS.map(id => [id, CONNECTOR_DEFINITIONS[id].modulePath])
));

function getConnectorDefinition(id) {
  return CONNECTOR_DEFINITIONS[id] || null;
}

function adapterForAction(type) {
  const contract = getActionContract(type);
  if (!contract || contract.availability === 'unavailable') return null;
  const adapter = contract.adapter;
  if (!adapter || typeof adapter !== 'object') return null;
  if (adapter.kind === 'inline') return adapter;
  if (adapter.kind === 'connector') {
    const definition = getConnectorDefinition(adapter.id);
    if (definition) return { ...adapter, requiresConnection: definition.requiresConnection };
  }
  return null;
}

function getExecutableActionCatalog() {
  return Object.entries(ACTION_CONTRACTS)
    .filter(([type, contract]) => contract.modelVisible !== false && contract.availability !== 'unavailable')
    .map(([type, contract]) => ({
      type,
      ...contract,
      adapter: adapterForAction(type)
    }))
    .filter(item => item.adapter);
}

function validateActionCatalog() {
  const errors = [];
  const seen = new Set();
  for (const [type, contract] of Object.entries(ACTION_CONTRACTS)) {
    if (seen.has(type)) errors.push(`duplicate action contract: ${type}`);
    seen.add(type);
    if (!Object.hasOwn(contract, 'adapter')) errors.push(`${type} is missing explicit adapter metadata`);
    if (contract.availability === 'unavailable') {
      if (contract.modelVisible !== false) errors.push(`${type} unavailable status is not explicit`);
      continue;
    }
    if (contract.modelVisible === false) {
      if (!adapterForAction(type)) errors.push(`${type} internal action has no valid adapter`);
      continue;
    }
    const adapter = adapterForAction(type);
    if (!adapter) errors.push(`${type} has no valid executable adapter`);
    if (adapter?.kind === 'connector' && !CONNECTOR_MODULES[adapter.id]) {
      errors.push(`${type} references unknown connector: ${adapter.id}`);
    }
  }
  return errors;
}

function assertValidActionCatalog({ loadConnectors = false } = {}) {
  const errors = validateActionCatalog();
  if (loadConnectors) {
    for (const [connectorId, definition] of Object.entries(CONNECTOR_DEFINITIONS)) {
      try {
        const connector = require(definition.modulePath);
        if (typeof connector?.execute !== 'function') errors.push(`connector ${connectorId} must export execute`);
      } catch (error) {
        errors.push(`connector ${connectorId} failed to load: ${error.message}`);
      }
    }
  }
  if (errors.length) throw new Error(`Invalid action catalog:\n- ${errors.join('\n- ')}`);
  return true;
}

function buildFunctionDeclarationsFromCatalog() {
  return getExecutableActionCatalog().map(item => actionToFunctionDeclaration(item.type, item));
}

function buildPublicActionCatalog() {
  return Object.fromEntries(getExecutableActionCatalog().map(item => [item.type, item]));
}

function buildAgentToolsCatalog(enabledConnectorIds = []) {
  const enabled = new Set(enabledConnectorIds);
  const catalog = getExecutableActionCatalog();
  const connectorIds = new Set(catalog
    .filter(action => action.adapter.kind === 'connector')
    .map(action => action.adapter.id));
  const tools = catalog.map(contract => ({
    id: contract.type,
    risk: contract.risk || 'low',
    executionMode: contract.executionMode || 'direct',
    confirmation: contract.confirmation || 'none',
    required: contract.required || [],
    available: contract.adapter.kind === 'inline'
      || contract.adapter.requiresConnection !== true
      || enabled.has(contract.adapter.id)
  }));
  return { tools, connectorIds };
}

function getExecutableSurfaceIds() {
  const surfaceIds = new Set();
  for (const action of getExecutableActionCatalog()) {
    if (action.adapter.kind === 'connector') surfaceIds.add(action.adapter.id);
    for (const surfaceId of action.surfaceIds || []) {
      if (typeof surfaceId === 'string' && surfaceId.trim()) surfaceIds.add(surfaceId);
    }
  }
  return surfaceIds;
}

function buildPublicConnectorCatalog(presentationConnectors, enabledConnectorIds = []) {
  const enabled = new Set(enabledConnectorIds);
  const implemented = getExecutableSurfaceIds();
  return (presentationConnectors || []).map(connector => ({
    ...connector,
    implemented: implemented.has(connector.id),
    connected: enabled.has(connector.id)
  }));
}

function buildAgentToolsResponse(presentationConnectors, enabledConnectorIds = []) {
  const { tools } = buildAgentToolsCatalog(enabledConnectorIds);
  const connectors = buildPublicConnectorCatalog(presentationConnectors, enabledConnectorIds)
    .map(({ icon, type, ...connector }) => connector);
  return {
    tools,
    connectors,
    capabilities: ['communication', 'productivity', 'development', 'travel', 'shopping', 'health', 'finance']
  };
}

module.exports = {
  CONNECTOR_IDS,
  CONNECTOR_DEFINITIONS,
  CONNECTOR_MODULES,
  getConnectorDefinition,
  adapterForAction,
  getExecutableActionCatalog,
  validateActionCatalog,
  assertValidActionCatalog,
  buildFunctionDeclarationsFromCatalog,
  buildPublicActionCatalog,
  buildAgentToolsCatalog,
  getExecutableSurfaceIds,
  buildPublicConnectorCatalog,
  buildAgentToolsResponse
};
