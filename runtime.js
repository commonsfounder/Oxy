const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const BASE_RUNTIME_ENV = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'OXY_SESSION_SECRET'
];

const BRAIN_PROVIDER_ENV = Object.freeze({
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  local: 'OXY_LOCAL_MODEL_BASE_URL'
});

let hasLoggedMissingRuntimeEnv = false;

function getMissingRuntimeEnv() {
  const provider = String(process.env.OXY_BRAIN_PROVIDER || 'openai').trim().toLowerCase();
  const providerKey = BRAIN_PROVIDER_ENV[provider] || BRAIN_PROVIDER_ENV.openai;
  const missing = [...BASE_RUNTIME_ENV, providerKey]
    .filter((name, index, names) => names.indexOf(name) === index)
    .filter(name => !process.env[name]);
  if (provider === 'gemini' && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return missing.filter(name => name !== 'GEMINI_API_KEY');
  }
  return missing;
}

function logMissingRuntimeEnvOnce(context = 'runtime') {
  const missing = getMissingRuntimeEnv();
  if (!missing.length || hasLoggedMissingRuntimeEnv) return missing;
  hasLoggedMissingRuntimeEnv = true;
  console.error(`[boot] Missing required env vars for ${context}: ${missing.join(', ')}`);
  return missing;
}

function createSupabaseServiceClient() {
  const missing = !process.env.SUPABASE_URL || !process.env.SUPABASE_KEY;
  if (missing) {
    logMissingRuntimeEnvOnce('supabase');
    throw new Error('SUPABASE_URL and SUPABASE_KEY must be configured before startup.');
  }
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );
}

function createGeminiServiceClient() {
  const provider = String(process.env.OXY_BRAIN_PROVIDER || 'openai').trim().toLowerCase();
  const needsGemini = provider === 'gemini' || String(process.env.OXY_VOICE_PROVIDER || '').trim().toLowerCase() === 'gemini';
  if (needsGemini && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    logMissingRuntimeEnvOnce('gemini');
  }
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'missing-gemini-api-key');
}

function validateTokenEncryptionKey() {
  const isProd = process.env.NODE_ENV === 'production' || process.env.OXY_REQUIRE_TOKEN_KEY === 'true';
  if (!isProd) return;
  try {
    // Import inside to avoid circular if any
    const { encryptionKey: _ } = require('./api/services/token-crypto'); // will trigger check inside
    // Force strict check
    require('./api/services/token-crypto').encryptTokens({}); // dummy to validate
  } catch (e) {
    console.error('[boot] Token encryption validation failed:', e.message);
    throw e;
  }
}

module.exports = {
  createGeminiServiceClient,
  createSupabaseServiceClient,
  getMissingRuntimeEnv,
  logMissingRuntimeEnvOnce,
  validateTokenEncryptionKey
};
