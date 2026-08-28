'use strict';

// Collapse a hostname to the site a session is filed under. Not a full public-suffix
// implementation — the multi-part suffixes that matter are listed below.

// Second-level suffixes where the registrable name is the THIRD label from the right.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.za', 'org.za',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br',
  'com.sg', 'com.my', 'com.hk', 'com.tw', 'com.mx', 'com.tr', 'com.ar',
  'co.in', 'net.in', 'org.in',
  'co.kr', 'or.kr'
]);

function registrableSite(input) {
  let host = String(input || '').trim().toLowerCase();
  if (!host) return '';

  // Callers hold both full URLs and bare hostnames.
  if (host.includes('://')) {
    try { host = new URL(host).hostname; } catch { return ''; }
  } else if (host.includes('/')) {
    host = host.split('/')[0];
  }

  host = host.replace(/\.$/, '').replace(/^\./, '');
  if (!host) return '';

  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');

  const lastTwo = labels.slice(-2).join('.');
  const keep = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

module.exports = { MULTI_PART_SUFFIXES, registrableSite };
