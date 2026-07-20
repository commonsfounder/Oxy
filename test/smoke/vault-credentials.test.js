const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeSite,
  validateCredentialInput,
  saveVaultCredential,
  listVaultCredentials,
  getVaultCredential,
  deleteVaultCredential
} = require('../../api/services/vault-credentials');

function fakeSupabase(rows = []) {
  return {
    from(table) {
      return {
        upsert(row) {
          return {
            select() {
              return {
                single: async () => {
                  const idx = rows.findIndex((r) => r.user_id === row.user_id && r.site === row.site);
                  const merged = { id: idx >= 0 ? rows[idx].id : `cred-${rows.length + 1}`, ...row };
                  if (idx >= 0) rows[idx] = merged; else rows.push(merged);
                  return {
                    data: { id: merged.id, site: merged.site, label: merged.label, username: merged.username, updated_at: merged.updated_at },
                    error: null
                  };
                }
              };
            }
          };
        },
        select() {
          return {
            eq(col, val) {
              const once = () => rows.filter((r) => r[col] === val);
              return {
                eq(col2, val2) {
                  const twice = () => once().filter((r) => r[col2] === val2);
                  return {
                    maybeSingle: async () => ({ data: twice()[0] || null, error: null }),
                    order: async () => ({ data: twice(), error: null })
                  };
                },
                order: async () => ({ data: once(), error: null })
              };
            }
          };
        },
        delete() {
          return {
            eq(col1, val1) {
              return {
                eq: async (col2, val2) => {
                  const remaining = rows.filter((r) => !(r[col1] === val1 && r[col2] === val2));
                  rows.length = 0;
                  rows.push(...remaining);
                  return { error: null };
                }
              };
            }
          };
        }
      };
    }
  };
}

test('normalizeSite lowercases and strips a leading www.', () => {
  assert.equal(normalizeSite('WWW.Delta.com'), 'delta.com');
  assert.equal(normalizeSite('  delta.com  '), 'delta.com');
  assert.equal(normalizeSite(''), '');
});

test('validateCredentialInput rejects missing site, label, or password', () => {
  assert.equal(validateCredentialInput({ label: 'x', password: 'y' }).ok, false);
  assert.equal(validateCredentialInput({ site: 'delta.com', password: 'y' }).ok, false);
  assert.equal(validateCredentialInput({ site: 'delta.com', label: 'x' }).ok, false);
});

test('validateCredentialInput normalizes site and trims fields', () => {
  const result = validateCredentialInput({ site: 'WWW.Delta.com', label: '  Delta  ', username: ' me ', password: 'pw' });
  assert.equal(result.ok, true);
  assert.equal(result.credential.site, 'delta.com');
  assert.equal(result.credential.label, 'Delta');
  assert.equal(result.credential.username, 'me');
});

test('saveVaultCredential then listVaultCredentials returns a masked summary with no password', async () => {
  const supabase = fakeSupabase();
  const saved = await saveVaultCredential(supabase, 'user-1', { site: 'delta.com', label: 'Delta SkyMiles', username: 'me@example.com', password: 'hunter2' });
  assert.equal(saved.ok, true);
  assert.equal(saved.credential.site, 'delta.com');
  assert.equal('password' in saved.credential, false);

  const { credentials } = await listVaultCredentials(supabase, 'user-1');
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].label, 'Delta SkyMiles');
  assert.equal('password' in credentials[0], false);
});

test('saveVaultCredential rejects invalid input without touching supabase', async () => {
  const supabase = fakeSupabase();
  const result = await saveVaultCredential(supabase, 'user-1', { site: '', label: 'x', password: 'y' });
  assert.equal(result.ok, false);
});

test('getVaultCredential returns the decrypted credential for the matching site only', async () => {
  const supabase = fakeSupabase();
  await saveVaultCredential(supabase, 'user-1', { site: 'delta.com', label: 'Delta', username: 'me', password: 'hunter2' });
  const found = await getVaultCredential(supabase, 'user-1', 'delta.com');
  assert.equal(found.password, 'hunter2');
  assert.equal(found.username, 'me');
  const missing = await getVaultCredential(supabase, 'user-1', 'united.com');
  assert.equal(missing, null);
});

test('deleteVaultCredential removes only the matching id for that user', async () => {
  const supabase = fakeSupabase();
  const saved = await saveVaultCredential(supabase, 'user-1', { site: 'delta.com', label: 'Delta', password: 'hunter2' });
  const result = await deleteVaultCredential(supabase, 'user-1', saved.credential.id);
  assert.equal(result.ok, true);
  const { credentials } = await listVaultCredentials(supabase, 'user-1');
  assert.equal(credentials.length, 0);
});
