'use strict';

const TOOLS = Object.freeze([
  { name: 'queryRoomState', description: 'Read current room signals and inferred state', permission: 'read', requiredCapabilities: [], sideEffects: [] },
  { name: 'queryEvents', description: 'Read recent physical events', permission: 'read', requiredCapabilities: [], sideEffects: [] },
  { name: 'queryDevice', description: 'Read device status and announced capabilities', permission: 'read', requiredCapabilities: [], sideEffects: [] },
  { name: 'searchMemory', description: 'Find relevant saved context', permission: 'read', requiredCapabilities: [], sideEffects: [] },
  { name: 'createWatch', description: 'Monitor a structured physical condition', permission: 'write', requiredCapabilities: [], sideEffects: ['persistent_watch'] },
  { name: 'cancelWatch', description: 'Cancel a persistent watch', permission: 'write', requiredCapabilities: [], sideEffects: ['persistent_watch'] }
]);

function executeTool(runtime, name, input = {}, { allowWrite = false } = {}) {
  const definition = TOOLS.find(item => item.name === name);
  if (!definition) throw new Error('Unknown physical tool');
  if (definition.permission === 'write' && !allowWrite) throw new Error('Tool requires explicit authorization');
  switch (name) {
    case 'queryRoomState': return runtime.roomState(input.roomId);
    case 'queryEvents': return runtime.store.list('events', input.limit || 20);
    case 'queryDevice': return runtime.publicDevice(runtime.store.get('devices', input.deviceId));
    case 'searchMemory': return runtime.searchMemory(input.query);
    case 'createWatch': return runtime.createWatch(input);
    case 'cancelWatch': return runtime.cancelWatch(input.watchId);
    default: throw new Error('Unknown physical tool');
  }
}

module.exports = { TOOLS, executeTool };
