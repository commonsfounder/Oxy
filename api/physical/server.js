'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { PhysicalRuntime } = require('./runtime');
const { PhysicalStore } = require('./store');
const { createAgent } = require('./agent');
const { iso, text } = require('./model');
const { TOOLS } = require('./tools');

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function body(request) {
  let value = '';
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 64_000) throw new Error('Request too large');
  }
  return value ? JSON.parse(value) : {};
}
function local(request) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress); }
function deviceMessage(runtime, device, message) {
  if (message.protocolVersion !== 1) throw new Error('Unsupported protocol version');
  text(message.messageId, 'message ID');
  iso(message.timestamp);
  if (Math.abs(runtime.now().getTime() - Date.parse(message.timestamp)) > 5 * 60_000) throw new Error('Device message timestamp outside allowed window');
  const key = `${device.id}:${message.messageId}`;
  if (runtime.store.get('device_messages', key)) throw new Error('Duplicate device message');
  return key;
}

function createPhysicalServer({ runtime = new PhysicalRuntime({
  store: new PhysicalStore(process.env.ADAM_PHYSICAL_DB || path.join(process.cwd(), 'data', 'adam-physical.sqlite')),
  environment: process.env.ADAM_ENVIRONMENT || (process.env.NODE_ENV === 'production' ? 'production' : 'development'),
  agent: createAgent(),
  speech: process.env.ADAM_LOCAL_SPEECH === '1' ? async text => runtime.speakLocally(text) : null,
  notification: process.env.ADAM_LOCAL_NOTIFICATIONS === '1' ? async text => runtime.notifyLocally(text) : null
}), adminToken = process.env.ADAM_ADMIN_TOKEN || null } = {}) {
  const clients = new Set();
  const onEvent = event => {
    const message = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of clients) response.write(message);
  };
  runtime.on('event', onEvent);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = request.method;
      const isAdminCommand = method === 'POST' && parts[0] === 'v1' && parts[1] === 'devices' && parts[3] === 'commands' && parts.length === 4;
      const isDevice = parts[0] === 'v1' && parts[1] === 'devices' && parts.length >= 3 && parts[2] !== 'register' && !isAdminCommand;
      const deviceId = isDevice ? parts[2] : null;
      const secret = String(request.headers.authorization || '').replace(/^Bearer /i, '');
      const device = isDevice ? runtime.authenticateDevice(deviceId, secret) : null;
      const admin = (local(request) && !adminToken) || Boolean(adminToken && request.headers['x-adam-admin-token'] === adminToken);
      if (isDevice && !device) return json(response, 401, { error: 'Device authentication failed' });
      if (!isDevice && !admin) return json(response, 401, { error: 'Admin authentication required' });

      if (method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end(fs.readFileSync(path.join(__dirname, 'console.html')));
      }
      if (method === 'GET' && url.pathname === '/v1/stream') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write(': connected\n\n'); clients.add(response);
        request.on('close', () => clients.delete(response)); return;
      }
      if (method === 'GET' && url.pathname === '/v1/snapshot') return json(response, 200, {
        environment: runtime.environment,
        users: runtime.store.all('users'), rooms: runtime.store.all('rooms'), devices: runtime.store.all('devices').map(item => runtime.publicDevice(item)),
        observations: runtime.store.list('observations', 50), events: runtime.store.list('events', 50),
        state: runtime.store.all('world_state').map(item => require('./model').currentState(item, runtime.now())),
        watches: runtime.store.all('watches'), actions: runtime.store.list('actions', 50), preferences: runtime.store.all('preferences'),
        commands: runtime.store.list('commands', 50)
      });
      if (method === 'GET' && parts[0] === 'v1' && parts[1] === 'rooms' && parts[3] === 'state') return json(response, 200, runtime.roomState(parts[2]));
      if (method === 'GET' && parts[0] === 'v1' && ['observations', 'events', 'watches', 'actions', 'inferences', 'memories', 'conversations', 'replay_runs'].includes(parts[1])) return json(response, 200, runtime.store.list(parts[1], url.searchParams.get('limit')));
      if (method === 'GET' && url.pathname === '/v1/preferences') return json(response, 200, runtime.store.all('preferences'));
      if (method === 'GET' && url.pathname === '/v1/users') return json(response, 200, runtime.store.all('users'));
      if (method === 'GET' && url.pathname === '/v1/tools') return json(response, 200, TOOLS);
      if (method === 'GET' && url.pathname === '/v1/memory/search') return json(response, 200, runtime.searchMemory(url.searchParams.get('q')));
      if (method === 'GET' && parts[0] === 'v1' && parts[1] === 'devices' && parts.length === 2) return json(response, 200, runtime.store.all('devices').map(item => runtime.publicDevice(item)));
      if (method === 'GET' && isDevice && parts[3] === 'commands') return json(response, 200, runtime.pendingCommands(deviceId));
      if (method === 'POST' && url.pathname === '/v1/rooms') return json(response, 201, runtime.createRoom(await body(request)));
      if (method === 'POST' && url.pathname === '/v1/users') return json(response, 201, runtime.createUser(await body(request)));
      if (method === 'POST' && url.pathname === '/v1/devices/register') return json(response, 201, runtime.registerDevice(await body(request)));
      if (method === 'POST' && url.pathname === '/v1/simulator/devices') return json(response, 201, runtime.registerDevice(await body(request), { simulator: true }));
      if (method === 'POST' && isDevice && parts[3] === 'heartbeat') {
        const input = await body(request); const key = deviceMessage(runtime, device, input);
        const result = runtime.heartbeat(deviceId, secret, input);
        runtime.store.put('device_messages', { id: key, createdAt: runtime.now().toISOString() });
        return json(response, 200, result);
      }
      if (method === 'POST' && isDevice && parts[3] === 'capabilities') {
        const input = await body(request); const key = deviceMessage(runtime, device, input);
        const result = runtime.announceCapabilities(deviceId, secret, input.capabilities);
        runtime.store.put('device_messages', { id: key, createdAt: runtime.now().toISOString() });
        return json(response, 200, result);
      }
      if (method === 'POST' && isDevice && parts[3] === 'observations') {
        const input = await body(request); const key = deviceMessage(runtime, device, input);
        const result = runtime.ingest(input, { device });
        runtime.store.put('device_messages', { id: key, createdAt: runtime.now().toISOString() });
        return json(response, 201, result);
      }
      if (method === 'POST' && isDevice && parts[3] === 'commands' && parts[5] === 'ack') {
        const input = await body(request); const key = deviceMessage(runtime, device, input);
        const result = runtime.acknowledgeCommand(deviceId, parts[4], input.status);
        runtime.store.put('device_messages', { id: key, createdAt: runtime.now().toISOString() });
        return json(response, 200, result);
      }
      if (method === 'POST' && url.pathname === '/v1/observations') return json(response, 201, runtime.ingest(await body(request), { origin: 'user_report' }));
      if (method === 'POST' && url.pathname === '/v1/replay') return json(response, 201, runtime.replay((await body(request)).observationId));
      if (method === 'POST' && url.pathname === '/v1/replay/sequence') return json(response, 201, runtime.replaySequence((await body(request)).observationIds));
      if (method === 'POST' && url.pathname === '/v1/watches') return json(response, 201, runtime.createWatch(await body(request)));
      if (method === 'POST' && url.pathname === '/v1/memories') return json(response, 201, runtime.remember(await body(request)));
      if (method === 'PUT' && parts[0] === 'v1' && parts[1] === 'preferences' && parts[2]) return json(response, 200, runtime.setPreferences(parts[2], await body(request)));
      if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'watches' && parts[3] === 'cancel') return json(response, 200, runtime.cancelWatch(parts[2]));
      if (method === 'POST' && url.pathname === '/v1/chat') { const input = await body(request); return json(response, 200, await runtime.chat(input.message, input)); }
      if (method === 'POST' && url.pathname === '/v1/tick') return json(response, 200, runtime.tick());
      if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'devices' && parts[3] === 'commands') { const input = await body(request); return json(response, 201, await runtime.command(parts[2], input.type, input.payload)); }
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = /authentication/i.test(error.message) ? 401 : /JSON|large|Invalid|Unknown|Unsupported|Duplicate|mismatch|disabled|required|announced|future/i.test(error.message) ? 400 : 500;
      return json(response, status, { error: error.message });
    }
  });
  const tickTimer = setInterval(() => runtime.tick(), 1000);
  tickTimer.unref();
  server.on('close', () => { clearInterval(tickTimer); runtime.off('event', onEvent); for (const client of clients) client.end(); });
  return { server, runtime };
}

if (require.main === module) {
  const host = process.env.ADAM_HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !process.env.ADAM_ADMIN_TOKEN) throw new Error('ADAM_ADMIN_TOKEN required for network binding');
  const port = Number(process.env.ADAM_PORT || 4317);
  const { server } = createPhysicalServer();
  server.listen(port, host, () => console.log(JSON.stringify({ component: 'adam.physical', status: 'listening', host, port })));
}

module.exports = { createPhysicalServer };
