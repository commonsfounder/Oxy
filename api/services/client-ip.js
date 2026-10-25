'use strict';

// Behind Cloudflare, Fly sees Cloudflare's address, not the visitor's. The visitor's address is in
// CF-Connecting-IP, which anyone could forge if they hit the app directly, so it is only believed
// when the connection really came from a Cloudflare address. Off unless OXY_TRUST_CLOUDFLARE=on.

const net = require('node:net');

const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];

const blocks = new net.BlockList();
for (const range of CLOUDFLARE_V4) { const [ip, bits] = range.split('/'); blocks.addSubnet(ip, Number(bits), 'ipv4'); }
for (const range of CLOUDFLARE_V6) { const [ip, bits] = range.split('/'); blocks.addSubnet(ip, Number(bits), 'ipv6'); }

function isCloudflareAddress(address) {
  const ip = String(address || '').trim().replace(/^::ffff:/i, '');
  const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  return family ? blocks.check(ip, family) : false;
}

function resolveClientIp(headers = {}, { trustCloudflare = false } = {}) {
  const flyIp = String(headers['fly-client-ip'] || '').trim();
  const forwarded = String(headers['cf-connecting-ip'] || '').trim();
  if (trustCloudflare && forwarded && net.isIP(forwarded) && isCloudflareAddress(flyIp)) return forwarded;
  return flyIp;
}

module.exports = { resolveClientIp, isCloudflareAddress };
