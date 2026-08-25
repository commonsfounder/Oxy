'use strict';

// Is a shared browser session still signed in?
//
// A session shared from the user's own browser can stop working for reasons none of which
// announce themselves: it expires, the site invalidates it, or the site refuses it when it
// arrives from a server in a different place to the browser that minted it. The agent then
// quietly behaves like a logged-out visitor, and the user has no way to know that is what
// happened — they just see worse results.
//
// This reads a page's own signals. It is deliberately willing to answer "not clear": a
// confident wrong answer here is worse than an honest unknown, because the whole point is
// to tell the user something they cannot otherwise see.

// Being asked for a password is the one signal the signed-in state cannot explain.
const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|authorize)\b/i;

// Present only when signed in. "Sign out" is the strongest: a logged-out page has nothing
// to sign out of.
// Calibrated against a real signed-in John Lewis account page, which said none of "sign
// out", "your orders" or "my orders" — it said "View all orders" and "Update your personal
// details". The first version read that page as inconclusive while the control was cleanly
// detected, which is the worst way to be wrong: confident about failure, silent about
// success. These are phrases a logged-out page has no reason to render.
const SIGNED_IN_RE = new RegExp([
  'sign out', 'log ?out',
  'view all orders', 'order history', '\\b(your|my) orders\\b',
  'buy (it )?again',
  'update your (personal )?details', 'your (account )?details',
  'saved (addresses|cards|payment)',
  'view your rewards'
].join('|'), 'i');

// Present when signed out — but also present in the header of nearly every shop page, so
// on its own this settles nothing.
const SIGNED_OUT_RE = /\b(sign in|log in|login|create an account|register)\b/i;

/**
 * @returns {{signedIn: boolean|null, because: string}}
 *   true  — the page shows something only a signed-in session produces
 *   false — the page is asking to sign in
 *   null  — genuinely not clear from this page
 */
function readSignedInSignals({ url = '', title = '', text = '', hasPasswordField = false } = {}) {
  const haystack = `${title} ${text}`.trim();
  if (!haystack && !url) return { signedIn: null, because: 'There was nothing on the page to read.' };

  // A live password field outranks everything else. A cached header can still say "Sign out"
  // while the body serves a login form; you cannot be asked to sign in and already be in.
  if (hasPasswordField) {
    return { signedIn: false, because: 'The page is showing a password field, so it is asking to sign in.' };
  }

  if (LOGIN_URL_RE.test(String(url))) {
    return { signedIn: false, because: `The site redirected to a login page (${url}).` };
  }

  const signedIn = SIGNED_IN_RE.exec(haystack);
  if (signedIn) {
    return { signedIn: true, because: `The page shows "${signedIn[0]}", which only appears once signed in.` };
  }

  const signedOut = SIGNED_OUT_RE.exec(haystack);
  if (signedOut) {
    // Every retail homepage carries this in its header, so it is not a verdict on its own.
    return {
      signedIn: null,
      because: `Not clear: the page offers "${signedOut[0]}" but shows no account controls either way.`
    };
  }

  return { signedIn: null, because: 'Not clear: the page showed no sign-in or account signals.' };
}

module.exports = { LOGIN_URL_RE, SIGNED_IN_RE, SIGNED_OUT_RE, readSignedInSignals };
