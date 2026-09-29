'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PhysicalStore } = require('./store');
const { PhysicalRuntime } = require('./runtime');
const { SimulatorAdapter } = require('./adapters');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adam-physical-demo-'));
  const database = path.join(directory, 'demo.sqlite');
  let time = Date.parse('2026-09-29T17:24:00Z');
  const runtime = new PhysicalRuntime({ store: new PhysicalStore(database), now: () => new Date(time),
    agent: async ({ message, context }) => ({
      kind: 'create_watch', response: 'I will check at half five.',
      watch: { roomId: context.room.room.id,
        condition: { kind: 'deadline_state', at: '2026-09-29T17:30:00.000Z', key: 'occupancy', value: 'probably_occupied' },
        action: { type: 'speak', text: "You wanted to leave by six. You may still be here, with about half an hour left." } }
    }) });
  try {
    const room = runtime.createRoom({ name: 'Hall' });
    const registered = runtime.registerDevice({ id: 'demo-motion', roomId: room.id, capabilities: ['motion'] }, { simulator: true });
    const adapter = new SimulatorAdapter(runtime, registered.device.id, registered.secret);
    const conversation = await runtime.chat('I need to leave at six. Tell me if I am still here around half five.', { roomId: room.id });
    time = Date.parse('2026-09-29T17:25:00Z');
    const observation = adapter.emitObservation('motion_detected', true, { sensor: 'motion' }).observation;
    time = Date.parse('2026-09-29T17:30:00Z');
    const triggers = runtime.tick();
    const action = runtime.store.all('actions')[0];
    console.log(JSON.stringify({ database, conversation, observation, occupancy: runtime.roomState(room.id).state.find(item => item.key === 'occupancy'), triggers, action, note: 'Scripted development agent and simulated evidence; no real notification was sent.' }, null, 2));
    if (process.argv.includes('--speak-preview')) {
      if (process.platform !== 'darwin') throw new Error('Speech preview requires macOS');
      await exec('/usr/bin/say', [action.text], { timeout: 30_000 });
      console.log('Spoke a development preview. The stored action remains simulated.');
    }
  } finally { runtime.store.close(); }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
