'use strict';

// Signing in to a site so Adam can use it, and forgetting that again. The sign-in itself happens on the
// phone, on the site's own page; the password never reaches Adam, only the signed-in session.

const { registrableSite } = require('../lib/site');

async function askSiteLogin({ params }) {
  const site = registrableSite(params?.site);
  if (!site) return { success: false, error: 'Which site should I sign in to?' };
  return {
    success: false,
    outcome: 'unavailable',
    site,
    error: `I need you to sign in to ${site}.`,
    text: `I'll need you to sign in to ${site} once so I can use it.`,
    recoveryAction: { type: 'reauth_login', site, label: `Sign in to ${site}`, message: `Sign in to ${site} so I can use it for you.`, autoContinue: false }
  };
}

async function forgetSiteLogin({ userId, params, deps }) {
  const site = registrableSite(params?.site);
  if (!site) return { success: false, error: 'Which site should I forget?' };
  const { error, count } = await deps.supabase.from('browser_sessions').delete({ count: 'exact' }).eq('user_id', userId).eq('site', site);
  if (error) return { success: false, error: 'I could not forget that login.' };
  return { success: true, text: count ? `I've forgotten your ${site} login.` : `I didn't have a ${site} login saved.` };
}

module.exports = { handlers: { ask_site_login: askSiteLogin, forget_site_login: forgetSiteLogin } };
