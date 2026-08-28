'use strict';

// Extension origins are allowed only because auth is header-only, never cookies.
// If cookie auth is ever added, pin them to known ids via OXY_ALLOWED_EXTENSION_IDS.

// Chrome extension ids are exactly 32 characters drawn from a–p.
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/([a-p]{32})$/;

function isAllowedOrigin(origin, { allowedOrigins = [], allowedExtensionIds = [] } = {}) {
  // No Origin header at all: curl, the iOS app, server-to-server. Not a browser, not CORS.
  if (!origin) return true;

  // An unset allowlist stays permissive, which is the behaviour this replaced.
  if (!allowedOrigins.length) return true;

  if (allowedOrigins.includes(origin)) return true;

  const match = EXTENSION_ORIGIN_RE.exec(origin);
  if (match) {
    return allowedExtensionIds.length ? allowedExtensionIds.includes(match[1]) : true;
  }

  return false;
}

module.exports = { EXTENSION_ORIGIN_RE, isAllowedOrigin };
