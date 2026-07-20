'use strict';

// General-purpose site-credential vault (Phase 2 of the aside-parity roadmap) — extends the
// agent-card.js pattern (server-side AES-256-GCM envelope, decrypted only at point of use)
// from payment cards to arbitrary site username/password credentials. One credential per
// (user, site) so a task's scoped grant (browser-task.js's session.allowedCredentialSites)
// can match a stored credential by plain domain equality, with no credential IDs threaded
// through chat or the model prompt.

const { encryptTokens, decryptTokens } = require('./token-crypto');

function normalizeSite(site) {
  return String(site || '').trim().toLowerCase().replace(/^www\./, '');
}

function validateCredentialInput({ site, label, username, password } = {}) {
  const normalizedSite = normalizeSite(site);
  if (!normalizedSite) return { ok: false, error: 'Site is required.' };
  const trimmedLabel = String(label || '').trim();
  if (!trimmedLabel) return { ok: false, error: 'Label is required.' };
  const trimmedPassword = String(password || '');
  if (!trimmedPassword.trim()) return { ok: false, error: 'Password is required.' };
  return {
    ok: true,
    credential: {
      site: normalizedSite,
      label: trimmedLabel,
      username: String(username || '').trim(),
      password: trimmedPassword
    }
  };
}

async function saveVaultCredential(supabase, userId, rawCredential) {
  const result = validateCredentialInput(rawCredential);
  if (!result.ok) return result;
  const { site, label, username, password } = result.credential;
  const { data, error } = await supabase
    .from('vault_credentials')
    .upsert({
      user_id: userId,
      site,
      label,
      username,
      tokens: encryptTokens({ username, password }),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,site' })
    .select('id, site, label, username, updated_at')
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, credential: data };
}

/** Masked list for clients — never includes the password. */
async function listVaultCredentials(supabase, userId) {
  const { data, error } = await supabase
    .from('vault_credentials')
    .select('id, site, label, username, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) return { credentials: [], error };
  return { credentials: data };
}

/** Full decrypted credential for one site — server-internal use only (confirmCredentialUse
 *  in browser-task.js). Never returned to a client or a model prompt. */
async function getVaultCredential(supabase, userId, site) {
  const normalizedSite = normalizeSite(site);
  if (!normalizedSite) return null;
  const { data } = await supabase
    .from('vault_credentials')
    .select('id, site, label, tokens')
    .eq('user_id', userId)
    .eq('site', normalizedSite)
    .maybeSingle();
  if (!data) return null;
  const decrypted = decryptTokens(data.tokens || {});
  if (!decrypted || !decrypted.password) return null;
  return { id: data.id, site: data.site, label: data.label, username: decrypted.username, password: decrypted.password };
}

async function deleteVaultCredential(supabase, userId, credentialId) {
  const { error } = await supabase
    .from('vault_credentials')
    .delete()
    .eq('id', credentialId)
    .eq('user_id', userId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = {
  normalizeSite,
  validateCredentialInput,
  saveVaultCredential,
  listVaultCredentials,
  getVaultCredential,
  deleteVaultCredential
};
