const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const REQUIRED_RUNTIME_ENV = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'GEMINI_API_KEY',
  'OXY_SESSION_SECRET'
];

let hasLoggedMissingRuntimeEnv = false;

function getMissingRuntimeEnv() {
  return REQUIRED_RUNTIME_ENV.filter(name => !process.env[name]);
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
  if (missing) logMissingRuntimeEnvOnce('supabase');
  return createClient(
    process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
    process.env.SUPABASE_KEY || 'placeholder-service-key'
  );
}

function createGeminiServiceClient() {
  if (!process.env.GEMINI_API_KEY) logMissingRuntimeEnvOnce('gemini');
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'missing-gemini-api-key');
}

module.exports = {
  createGeminiServiceClient,
  createSupabaseServiceClient,
  getMissingRuntimeEnv,
  logMissingRuntimeEnvOnce
};
