'use strict';
// Lets a signed-in person watch and take over their sandbox browser (sign-in, 3DS, captcha).
// The sandbox's viewer is only reachable with a token this server holds, so the app goes
// through here: a short-lived link in, an authenticated proxy out.

const { createHmac, timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const sandboxes = require('./browser-sandbox');

const LINK_TTL_MS = 10 * 60 * 1000;
const PREFIX = '/agent/browser/live/';
const wss = new WebSocketServer({ noServer: true });

function secret() {
  const value = process.env.OXY_SESSION_SECRET;
  if (!value) throw new Error('OXY_SESSION_SECRET is not set');
  return value;
}

const sign = (body) => createHmac('sha256', secret()).update(`browser-live:${body}`).digest('base64url');

function issueToken(userId, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ u: userId, e: now + LINK_TTL_MS })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function verifyToken(token, now = Date.now()) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return u && e > now ? u : null;
  } catch { return null; }
}

/** A link for this user's live browser, or null when they have no sandbox browser running. */
function createLink(userId) {
  if (!sandboxes.viewTarget(userId)) return null;
  const token = issueToken(userId);
  const root = `${PREFIX}${token}/`;
  return {
    url: `${root}vnc.html?autoconnect=1&resize=scale&reconnect=1&path=${encodeURIComponent(`${root}websockify`.slice(1))}`,
    expiresInSeconds: LINK_TTL_MS / 1000,
  };
}

function split(pathAndQuery) {
  const rest = pathAndQuery.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  return { token: rest.slice(0, slash), tail: rest.slice(slash) };
}

async function proxyHttp(req, res) {
  const parts = split(req.originalUrl || req.url);
  const userId = parts && verifyToken(parts.token);
  const target = userId && sandboxes.viewTarget(userId);
  if (!target) return res.status(404).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const upstream = await fetch(`${target.base}${parts.tail}`, { headers: target.headers, signal: AbortSignal.timeout(15000) });
    res.status(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch { res.status(502).end(); }
}

/** For http.Server 'upgrade': returns true when it handled (or rejected) a live-view socket. */
function handleUpgrade(req, socket, head) {
  if (!req.url.startsWith(PREFIX)) return false;
  const parts = split(req.url);
  const userId = parts && verifyToken(parts.token);
  const target = userId && sandboxes.viewTarget(userId);
  if (!target) { socket.destroy(); return true; }
  const upstream = new WebSocket(`${target.base.replace(/^http/, 'ws')}${parts.tail}`,
    ['binary'], { headers: target.headers });
  upstream.once('open', () => {
    wss.handleUpgrade(req, socket, head, (client) => {
      client.on('message', (data, isBinary) => upstream.readyState === 1 && upstream.send(data, { binary: isBinary }));
      upstream.on('message', (data, isBinary) => client.readyState === 1 && client.send(data, { binary: isBinary }));
      client.on('close', () => upstream.close());
      upstream.on('close', () => client.close());
      client.on('error', () => upstream.terminate());
      upstream.on('error', () => client.terminate());
    });
  });
  upstream.once('error', () => socket.destroy());
  return true;
}

module.exports = { createLink, proxyHttp, handleUpgrade, issueToken, verifyToken, PREFIX };
