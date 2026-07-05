'use strict';

function isProductionEnv(env = process.env) {
  return env.NODE_ENV === 'production' || env.OXY_REQUIRE_PROACTIVE_SWEEP_SECRET === 'true';
}

function proactiveSweepAuthorization(req, env = process.env) {
  const configuredSecret = env.PROACTIVE_SWEEP_SECRET;
  if (!configuredSecret) {
    if (isProductionEnv(env)) {
      return {
        ok: false,
        status: 503,
        error: 'Proactive sweep secret is not configured.'
      };
    }
    return { ok: true, unsecured: true };
  }

  const provided = req.get('x-proactive-secret') || req.query?.secret || req.body?.secret;
  if (provided !== configuredSecret) {
    return {
      ok: false,
      status: 401,
      error: 'Invalid proactive sweep secret.'
    };
  }

  return { ok: true };
}

module.exports = {
  isProductionEnv,
  proactiveSweepAuthorization
};
