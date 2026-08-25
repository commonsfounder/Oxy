'use strict';

// Which origins may call this API.
//
// The Chrome session-share extension calls from `chrome-extension://<id>`. That is not a
// website, was never in the allowlist, and so every request from it was rejected — surfacing
// to the user as an unexplained HTTP 500 with nothing in the response to say why.
//
// Allowing extension origins is safe *here specifically* because this API authenticates on
// headers only: Bearer or X-Session-Token, never cookies (see auth.js's
// getProvidedSessionToken). CORS exists to stop a hostile page spending the browser's
// ambient credentials on the user's behalf; with no cookie auth there are none to spend, so
// an extension origin still has to present a real token like anything else.
//
// **If cookie-based auth is ever added, this reasoning collapses and extension origins must
// be pinned to known ids** — which OXY_ALLOWED_EXTENSION_IDS already supports.

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
