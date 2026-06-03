const http = require('http');
const app = require('./api/index.js');
const { getMissingRuntimeEnv, logMissingRuntimeEnvOnce } = require('./runtime');

if (require.main === module) {
  const missing = getMissingRuntimeEnv();
  if (missing.length) logMissingRuntimeEnvOnce('server startup');
  const PORT = Number(process.env.PORT) || 3000;
  const server = http.createServer(app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Oxy listening on :${PORT}`);
    if (missing.length) {
      console.warn(`[boot] Oxy started with missing env vars: ${missing.join(', ')}`);
    }
  });
}

module.exports = app;
