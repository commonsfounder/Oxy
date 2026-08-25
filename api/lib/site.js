'use strict';

// Collapse a hostname to the site a session should be filed under.
//
// The first real shared session went in as `account.johnlewis.com`, because that is the page
// the user was on when they clicked share. The ordering loop looks sessions up by the site it
// derives from the shopping URL — `johnlewis.com` — so the session it had just been handed
// was invisible to it. The account page is exactly where someone goes to confirm they are
// signed in, so that is the likely case, not the edge case.
//
// A note kept deliberately short: this is not a full public-suffix implementation. Bringing
// in the real list would be a dependency for one function, so the multi-part suffixes that
// matter for a UK-first shopping agent are listed instead. Collapsing to the last two labels
// alone would file every British site under `co.uk`.

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
