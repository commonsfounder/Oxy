const http = require('http');
const app = require('./api/index.js');
const { getMissingRuntimeEnv, logMissingRuntimeEnvOnce, validateTokenEncryptionKey } = require('./runtime');

if (require.main === module) {
  const missing = getMissingRuntimeEnv();
  if (missing.length) logMissingRuntimeEnvOnce('server startup');
  try {
    validateTokenEncryptionKey();
  } catch (e) {
    console.error('[boot] Halting due to token encryption misconfiguration.');
    process.exit(1);
  }
  const PORT = Number(process.env.PORT) || 3000;
  const server = http.createServer(app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Oxy listening on :${PORT}`);
    if (missing.length) {
      console.warn(`[boot] Oxy started with missing env vars: ${missing.join(', ')}`);
    }
    // Launch one spare browser now (it's a ~4s cold start) so the first browser task of
    // this instance's life grabs it instantly instead of paying that inside the request.
    try {
      const bt = require('./api/services/browser-task');
      bt.primeWarmBrowser();
      bt.primeFastpaths();
    } catch { /* non-fatal */ }
  });
}

module.exports = app;
