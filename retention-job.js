const { runRetentionSweep } = require('./api/index.js');
const { getMissingRuntimeEnv, logMissingRuntimeEnvOnce } = require('./runtime');

// Standalone entrypoint for the data-retention sweep. Deploy as a Cloud Run Job
// on a daily schedule (mirrors proactive-job.js). Enforces the bounded-retention
// promise made on /privacy.
async function main() {
  const missing = getMissingRuntimeEnv();
  if (missing.length) {
    logMissingRuntimeEnvOnce('retention job startup');
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  const summary = await runRetentionSweep(console);
  console.log(`[retention-job] completed ${JSON.stringify(summary)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[retention-job] failed', err);
    process.exit(1);
  });
