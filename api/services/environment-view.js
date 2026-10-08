'use strict';

const browserSessions = require('./browser-session');
const frames = new WeakMap();
const MAX_FRAME_BYTES = 1500000;
const FRAME_INTERVAL_MS = 1000;

function pageAddress(value) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin + url.pathname : ''; }
  catch { return ''; }
}

// Viewing never creates, resumes, extends or controls an agent session.
async function getEnvironmentView(userId, { taskId = null, now = Date.now() } = {}) {
  const session = browserSessions.getSession(userId);
  const unavailable = { kind: 'browser', state: 'disconnected', capturedAt: null, frame: null, taskId: taskId || null };
  if (!session || (taskId && session.agentTaskId !== taskId) || session.page.isClosed() || !session.browser.isConnected()) return unavailable;
  let cached = frames.get(session);
  if (cached?.pending) return cached.pending;
  if (cached?.snapshot && now - cached.at < FRAME_INTERVAL_MS) return cached.snapshot;
  const pending = (async () => {
    const base = { kind: 'browser', state: 'unavailable', taskId: session.agentTaskId || null,
      capturedAt: null, frame: null, address: pageAddress(session.page.url()), title: '' };
    try {
      const image = await session.page.screenshot({ type: 'jpeg', quality: 60, timeout: 3000,
        mask: [session.page.locator('input[type="password"]')] });
      if (image.length > MAX_FRAME_BYTES) return base;
      const capturedAt = new Date().toISOString();
      const title = String(await browserSessions.withTimeout(session.page.title(), 1000, 'page title').catch(() => '')).slice(0, 180);
      // A screenshot completing after replacement must never be labelled a live session.
      if (browserSessions.getSession(userId) !== session || session.page.isClosed() || !session.browser.isConnected()) return unavailable;
      const snapshot = { ...base, state: 'live', capturedAt,
        title,
        ...(session.lastAction ? { lastAction: { label: String(session.lastAction.label).slice(0, 120), at: session.lastAction.at } } : {}),
        frame: { mimeType: 'image/jpeg', data: image.toString('base64') } };
      frames.set(session, { at: Date.now(), snapshot });
      return snapshot;
    } catch { return base; }
  })();
  frames.set(session, { ...cached, pending });
  try { return await pending; }
  finally { const current = frames.get(session); if (current?.pending === pending) frames.delete(session); }
}

module.exports = { getEnvironmentView, pageAddress, MAX_FRAME_BYTES };
