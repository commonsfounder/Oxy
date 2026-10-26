'use strict';

// Keeps server-side fetches and the headless browser off private networks. Enforced in
// production (or with OXY_BLOCK_PRIVATE_URLS=on); local tests may use loopback fixtures.

const dns = require('node:dns').promises;
const net = require('node:net');

function enforced(env = process.env) {
  if (env.OXY_BLOCK_PRIVATE_URLS === 'on') return true;
  return env.NODE_ENV === 'production' && env.OXY_BLOCK_PRIVATE_URLS !== 'off';
}

function isPrivateIPv4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family !== 6) return false;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  // The URL parser rewrites a mapped address into hex groups.
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
}

// Name-only checks that need no lookup: loopback, IP literals, internal suffixes, one-word hosts.
function hostLooksPrivate(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (net.isIP(host)) return isPrivateAddress(host);
  if (!host.includes('.')) return true;
  return /\.(localhost|local|internal|lan|home\.arpa|corp)$/.test(host);
}

function assertPublicHostName(rawUrl, env = process.env) {
  if (!enforced(env)) return;
  let url;
  try { url = new URL(String(rawUrl)); } catch { throw new Error('That is not a valid web address.'); }
  if (!/^https?:$/.test(url.protocol) || hostLooksPrivate(url.hostname)) {
    throw new Error('That address points at a private network, so I will not open it.');
  }
}

async function assertPublicHttpUrl(rawUrl, env = process.env) {
  if (!enforced(env)) return;
  assertPublicHostName(rawUrl, env);
  const host = new URL(String(rawUrl)).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;
  let addresses;
  try { addresses = await dns.lookup(host, { all: true }); } catch { return; }
  if (addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('That address points at a private network, so I will not open it.');
  }
}

module.exports = { assertPublicHttpUrl, assertPublicHostName, isPrivateAddress, hostLooksPrivate, enforced };
