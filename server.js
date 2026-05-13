const app = require('./api/index.js');

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Oxy listening on :${PORT}`);
  });
}

module.exports = app;
