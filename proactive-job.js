const { runProactiveSweep } = require('./api/index.js');
const { getMissingRuntimeEnv, logMissingRuntimeEnvOnce } = require('./runtime');

async function main() {
  const missing = getMissingRuntimeEnv();
  if (missing.length) {
    logMissingRuntimeEnvOnce('proactive job startup');
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  const summary = await runProactiveSweep(console);
  console.log(`[proactive-job] completed ${JSON.stringify(summary)}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[proactive-job] failed', err);
    process.exit(1);
  });
