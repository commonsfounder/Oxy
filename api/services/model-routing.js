'use strict';

const ROUTE_KEYS = Object.freeze({ provider: 'model_route_provider', model: 'model_route_model' });

const MODEL_ENV_KEYS = Object.freeze({
  reasoning: 'OXY_REASONING_MODEL',
  fast: 'OXY_FAST_MODEL'
});

const PROVIDER_MODEL_ENV_KEYS = Object.freeze({
  openai: { reasoning: 'OXY_OPENAI_MODEL', fast: 'OXY_OPENAI_FAST_MODEL' },
  anthropic: { reasoning: 'OXY_ANTHROPIC_MODEL', fast: 'OXY_ANTHROPIC_FAST_MODEL' },
  gemini: { reasoning: 'OXY_GEMINI_MODEL', fast: 'OXY_GEMINI_FAST_MODEL' },
  groq: { reasoning: 'OXY_GROQ_MODEL', fast: 'OXY_GROQ_FAST_MODEL' },
  local: { reasoning: 'OXY_LOCAL_MODEL', fast: 'OXY_LOCAL_FAST_MODEL' }
});

// These prefixes are strong signals that a model belongs to another provider.
// We use them only to stop a stale environment value from crossing a provider
// boundary. Unknown model names remain valid for compatible or local providers.
const MODEL_FAMILY_PREFIXES = Object.freeze({
  openai: /^(?:gpt-|o\d|chatgpt|text-)/i,
  anthropic: /^claude-/i,
  gemini: /^gemini-/i,
  groq: /^(?:llama|mixtral|mistral|qwen|gemma|deepseek)-/i
});

const PROVIDERS = Object.freeze({
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultModel: () => defaultModelForProvider('openai'),
    envKeys: ['OPENAI_API_KEY'],
    capabilities: ['general', 'agentic', 'streaming']
  },
  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    defaultModel: () => defaultModelForProvider('anthropic'),
    envKeys: ['ANTHROPIC_API_KEY'],
    capabilities: ['general', 'agentic', 'streaming']
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    defaultModel: () => defaultModelForProvider('gemini'),
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    capabilities: ['general', 'agentic', 'streaming', 'grounding']
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    defaultModel: () => defaultModelForProvider('groq'),
    envKeys: ['GROQ_API_KEY'],
    capabilities: ['general', 'streaming']
  },
  local: {
    id: 'local',
    name: 'Local model',
    defaultModel: () => defaultModelForProvider('local'),
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

function modelMatchesProvider(provider, model) {
  const value = String(model || '').trim();
  if (!value || provider === 'local') return true;
  const family = MODEL_FAMILY_PREFIXES[provider];
  if (family?.test(value)) return true;
  return !Object.entries(MODEL_FAMILY_PREFIXES)
    .some(([otherProvider, pattern]) => otherProvider !== provider && pattern.test(value));
}

function defaultModelForProvider(provider, role = 'reasoning', env = process.env) {
  const normalised = normaliseProvider(provider) || 'openai';
  const providerKey = PROVIDER_MODEL_ENV_KEYS[normalised]?.[role];
  const legacyKey = MODEL_ENV_KEYS[role];
  const candidate = String(
    (providerKey && env[providerKey]) || env[legacyKey] || ''
  ).trim();
  if (candidate && modelMatchesProvider(normalised, candidate)) return candidate;

  switch (normalised) {
    case 'openai': return 'gpt-5.6-luna';
    case 'anthropic': return 'claude-sonnet-5';
    case 'gemini': return role === 'fast' ? 'gemini-2.5-flash' : 'gemini-2.5-flash';
    case 'groq': return 'llama-3.3-70b-versatile';
    case 'local': return 'llama3.2';
    default: return 'gpt-5.6-luna';
  }
}

function providerConfiguration(provider, model = defaultModelForProvider(provider)) {
  const definition = PROVIDERS[provider];
  if (!definition) {
    return { provider, model, configured: false, ready: false, issue: 'Unknown model provider.' };
  }
  const missingKeys = definition.envKeys.filter(key => !String(process.env[key] || '').trim());
  const modelMatches = modelMatchesProvider(provider, model);
  let issue = null;
  if (missingKeys.length) issue = `Missing ${missingKeys.join(', ')}.`;
  else if (!modelMatches) issue = 'The model does not match the selected provider.';
  return {
    provider,
    model,
    configured: missingKeys.length === 0,
    ready: missingKeys.length === 0 && modelMatches,
    issue,
    missingKeys
  };
}

function getConfiguredDefaultRoute() {
  const envProvider = normaliseProvider(process.env.OXY_BRAIN_PROVIDER) || 'openai';
  const provider = providerConfigured(envProvider) || !process.env.OXY_BRAIN_PROVIDER
    ? envProvider
    : 'openai';
  const model = defaultModelForProvider(provider);
  return {
    provider,
    model,
    configured: providerConfigured(provider),
    configuration: providerConfiguration(provider, model),
    source: 'server'
  };
}

function resolveModelRoute(preferences = {}, options = {}) {
  const fallback = getConfiguredDefaultRoute();
  const requestedProvider = normaliseProvider(preferences[ROUTE_KEYS.provider]);
  const requestedModel = normaliseModel(requestedProvider, preferences[ROUTE_KEYS.model]);
  if (!requestedProvider) return { ...fallback, source: 'server' };

  const definition = PROVIDERS[requestedProvider];
  const model = requestedModel && modelMatchesProvider(requestedProvider, requestedModel)
    ? requestedModel
    : defaultModelForProvider(requestedProvider);
  return {
    provider: requestedProvider,
    model,
    configured: providerConfigured(requestedProvider),
    configuration: providerConfiguration(requestedProvider, model),
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
      configured: active.configured,
      ready: active.configuration?.ready !== false,
      issue: active.configuration?.issue || null
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
  if (!modelMatchesProvider(provider, model)) {
    return { error: 'That model does not match the selected provider.' };
  }
  return { provider, model };
}

module.exports = {
  PROVIDERS,
  ROUTE_KEYS,
  providerConfigured,
  providerConfiguration,
  defaultModelForProvider,
  modelMatchesProvider,
  resolveModelRoute,
  publicModelRouting,
  validateModelRouteInput
};
