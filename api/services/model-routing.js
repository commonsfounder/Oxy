'use strict';

const ROUTE_KEYS = Object.freeze({ provider: 'model_route_provider', model: 'model_route_model' });

const PROVIDERS = Object.freeze({
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultModel: () => process.env.OXY_REASONING_MODEL || 'gpt-5.6-luna',
    envKeys: ['OPENAI_API_KEY'],
    capabilities: ['general', 'agentic', 'streaming']
  },
  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    defaultModel: () => process.env.OXY_ANTHROPIC_MODEL || 'claude-sonnet-5',
    envKeys: ['ANTHROPIC_API_KEY'],
    capabilities: ['general', 'agentic', 'streaming']
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    defaultModel: () => process.env.OXY_GEMINI_MODEL || 'gemini-2.5-flash',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    capabilities: ['general', 'agentic', 'streaming', 'grounding']
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    defaultModel: () => process.env.OXY_GROQ_MODEL || 'llama-3.3-70b-versatile',
    envKeys: ['GROQ_API_KEY'],
    capabilities: ['general', 'streaming']
  },
  local: {
    id: 'local',
    name: 'Local model',
    defaultModel: () => process.env.OXY_LOCAL_MODEL || 'llama3.2',
    envKeys: ['OXY_LOCAL_MODEL_BASE_URL'],
    capabilities: ['general', 'agentic', 'streaming']
  }
});

function providerConfigured(provider) {
  const definition = PROVIDERS[provider];
  return Boolean(definition && definition.envKeys.some(key => String(process.env[key] || '').trim()));
}

function normaliseProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return PROVIDERS[provider] ? provider : null;
}

function normaliseModel(provider, value) {
  const model = String(value || '').trim();
  if (!provider || !model || model.length > 120 || /[\r\n]/.test(model)) return null;
  return model;
}

function getConfiguredDefaultRoute() {
  const envProvider = normaliseProvider(process.env.OXY_BRAIN_PROVIDER) || 'openai';
  const provider = providerConfigured(envProvider) || !process.env.OXY_BRAIN_PROVIDER
    ? envProvider
    : 'openai';
  return {
    provider,
    model: PROVIDERS[provider].defaultModel(),
    configured: providerConfigured(provider),
    source: 'server'
  };
}

function resolveModelRoute(preferences = {}, options = {}) {
  const fallback = getConfiguredDefaultRoute();
  const requestedProvider = normaliseProvider(preferences[ROUTE_KEYS.provider]);
  const requestedModel = normaliseModel(requestedProvider, preferences[ROUTE_KEYS.model]);
  if (!requestedProvider) return { ...fallback, source: 'server' };

  const definition = PROVIDERS[requestedProvider];
  return {
    provider: requestedProvider,
    model: requestedModel || definition.defaultModel(),
    configured: providerConfigured(requestedProvider),
    source: 'user',
    capabilities: definition.capabilities,
    fallback: options.includeFallback === false ? undefined : fallback
  };
}

function publicModelRouting(preferences = {}) {
  const selected = resolveModelRoute(preferences);
  const active = selected.configured ? selected : selected.fallback;
  return {
    selected: {
      provider: selected.provider,
      model: selected.model,
      configured: selected.configured,
      source: selected.source
    },
    active: {
      provider: active.provider,
      model: active.model,
      configured: active.configured
    },
    providers: Object.values(PROVIDERS).map(definition => ({
      id: definition.id,
      name: definition.name,
      defaultModel: definition.defaultModel(),
      configured: providerConfigured(definition.id),
      capabilities: definition.capabilities
    }))
  };
}

function validateModelRouteInput(input = {}) {
  const provider = normaliseProvider(input.provider);
  if (!provider) return { error: 'Choose a supported model provider.' };
  const model = normaliseModel(provider, input.model) || PROVIDERS[provider].defaultModel();
  return { provider, model };
}

module.exports = {
  PROVIDERS,
  ROUTE_KEYS,
  providerConfigured,
  resolveModelRoute,
  publicModelRouting,
  validateModelRouteInput
};
