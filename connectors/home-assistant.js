'use strict';

const axios = require('axios');

function clean(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function homeAssistantConfig(env = process.env) {
  const baseUrl = String(env.HOME_ASSISTANT_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.HOME_ASSISTANT_TOKEN || '').trim();
  return baseUrl && token ? { baseUrl, token } : null;
}

function resolveEntityId(device, env = process.env) {
  const explicit = String(device || '').trim().toLowerCase();
  if (/^[a-z][a-z0-9_]+\.[a-z0-9_]+$/.test(explicit)) return explicit;

  const key = explicit.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  const mapped = String(env[`HOME_ASSISTANT_ENTITY_${key}`] || '').trim().toLowerCase();
  if (/^[a-z][a-z0-9_]+\.[a-z0-9_]+$/.test(mapped)) return mapped;

  try {
    const map = JSON.parse(String(env.HOME_ASSISTANT_ENTITY_MAP || '{}'));
    const fromMap = String(map[explicit] || '').trim().toLowerCase();
    if (/^[a-z][a-z0-9_]+\.[a-z0-9_]+$/.test(fromMap)) return fromMap;
  } catch {
    // A malformed optional map is equivalent to no alias; the explicit entity-id path still
    // works and the returned error tells the user what configuration is missing.
  }
  return null;
}

function commandToService(entityId, command) {
  const [domain] = entityId.split('.');
  const text = String(command || '').trim().toLowerCase();
  if (!text) return { error: 'A smart-home command is required.' };

  if (['on', 'off', 'toggle'].includes(text)) {
    const supported = new Set(['light', 'switch', 'fan', 'input_boolean', 'group', 'cover']);
    if (!supported.has(domain)) return { error: `The ${domain} domain does not support a simple ${text} command.` };
    const service = domain === 'cover'
      ? (text === 'on' ? 'open_cover' : text === 'off' ? 'close_cover' : 'toggle')
      : (text === 'toggle' ? 'toggle' : `turn_${text}`);
    return { domain, service, data: { entity_id: entityId } };
  }

  const temperature = text.match(/^set(?:\s+temperature)?\s+(-?\d+(?:\.\d+)?)\s*(?:°?c)?$/i);
  if (temperature) {
    if (domain !== 'climate') return { error: 'A temperature command requires a climate entity.' };
    return {
      domain,
      service: 'set_temperature',
      data: { entity_id: entityId, temperature: Number(temperature[1]) }
    };
  }

  return { error: 'Supported smart-home commands are on, off, toggle, or set <temperature>.' };
}

async function executeConfigured({ config, device, command, request = axios } = {}) {
  const entityId = resolveEntityId(device);
  if (!entityId) {
    return {
      success: false,
      outcome: 'unavailable',
      unavailable: true,
      error: 'That smart-home device is not mapped. Use its Home Assistant entity id or configure HOME_ASSISTANT_ENTITY_MAP.'
    };
  }
  const service = commandToService(entityId, command);
  if (service.error) return { success: false, outcome: 'failed', error: service.error };

  const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
  const serviceUrl = `${config.baseUrl}/api/services/${service.domain}/${service.service}`;
  try {
    await request.post(serviceUrl, service.data, { headers, timeout: 15000 });
  } catch (error) {
    return {
      success: false,
      outcome: 'failed',
      error: `Home Assistant did not accept the command: ${clean(error.response?.data?.message || error.message)}`
    };
  }

  // A 200 from the service endpoint means HA accepted the request, not that the device
  // reached the requested state. Read it back before reporting success.
  try {
    const state = await request.get(`${config.baseUrl}/api/states/${entityId}`, { headers, timeout: 15000 });
    const current = clean(state.data?.state || 'unknown', 60);
    return {
      success: true,
      text: `${entityId} is now ${current}.`,
      entityId,
      state: current,
      command: service.service
    };
  } catch (error) {
    return {
      success: false,
      outcome: 'failed',
      executed: true,
      entityId,
      error: `Home Assistant accepted the command for ${entityId}, but I could not verify its state: ${clean(error.message)}`
    };
  }
}

async function execute(_userId, action, params = {}) {
  if (action !== 'control_smart_home') return { success: false, error: 'Unknown Home Assistant action.' };
  const config = homeAssistantConfig();
  if (!config) {
    return {
      success: false,
      outcome: 'unavailable',
      unavailable: true,
      error: 'Smart-home control is unavailable until HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN are configured.'
    };
  }
  return executeConfigured({ config, device: params.device || params.entity_id, command: params.command });
}

module.exports = {
  execute,
  commandToService,
  homeAssistantConfig,
  resolveEntityId,
  executeConfigured
};
