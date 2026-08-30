#!/usr/bin/env node
'use strict';

// PROTOTYPE: throwaway terminal shell around the pure gaming-state module.

const readline = require('node:readline');
const { PLATFORMS, initialState, inputAllowed, transition } = require('./gaming-state');

const bold = value => `\x1b[1m${value}\x1b[0m`;
const dim = value => `\x1b[2m${value}\x1b[0m`;
let state = initialState();

function render() {
  if (process.stdout.isTTY) console.clear();
  const adapter = PLATFORMS[state.platform];
  const permission = inputAllowed(state);
  console.log(bold('ADAM GAMING LOOP — PROTOTYPE'));
  console.log(dim('No real game, console, capture device, or controller is connected.'));
  console.log('');
  console.log(`${bold('phase')}           ${state.phase}`);
  console.log(`${bold('platform')}        ${adapter.label}`);
  console.log(`${bold('observation')}     ${adapter.observation}`);
  console.log(`${bold('input')}           ${adapter.input}`);
  console.log(`${bold('mode')}            ${state.mode}`);
  console.log(`${bold('session')}         ${state.sessionType}`);
  console.log(`${bold('bridge')}          ${state.bridgeReady ? 'ready' : 'unavailable'}`);
  console.log(`${bold('control allowed')} ${permission.allowed ? 'yes' : `no · ${permission.reason}`}`);
  console.log(`${bold('goal')}            ${state.goal || '—'}`);
  console.log(`${bold('observation')}     ${state.observation?.summary || '—'}`);
  console.log(`${bold('proposed action')} ${state.proposedAction?.intent || '—'}`);
  console.log(`${bold('last outcome')}    ${state.lastOutcome || '—'}`);
  console.log(`${bold('frames/actions')}  ${state.framesSeen} / ${state.actionsIssued}`);
  console.log(`${bold('blocked')}         ${state.blockedReason || '—'}`);
  console.log('');
  console.log(bold('Recent transitions'));
  console.log(state.history.length ? state.history.map(item => `  ${dim(item)}`).join('\n') : dim('  —'));
  console.log('');
  console.log(bold('Commands'));
  console.log(dim('platform pc_keyboard|pc_gamepad|ps5|xbox'));
  console.log(dim('connect · disconnect · bridge on|off'));
  console.log(dim('mode observe|assist|control'));
  console.log(dim('session single_player|local_coop|private_multiplayer|public_competitive'));
  console.log(dim('goal <outcome> · frame <what Adam sees> · decide <next intent> · act'));
  console.log(dim('verify yes|no · interrupt · resume · help · quit'));
}

function eventFor(line) {
  const [command, ...rest] = line.trim().split(/\s+/);
  const value = rest.join(' ');
  if (command === 'platform') return { type: 'SELECT_PLATFORM', platform: value };
  if (command === 'connect') return { type: 'CONNECT' };
  if (command === 'disconnect') return { type: 'DISCONNECT' };
  if (command === 'bridge') return { type: 'SET_BRIDGE', ready: value === 'on' };
  if (command === 'mode') return { type: 'SET_MODE', mode: value };
  if (command === 'session') return { type: 'SET_SESSION_TYPE', sessionType: value };
  if (command === 'goal') return { type: 'SET_GOAL', goal: value };
  if (command === 'frame') return { type: 'OBSERVE', summary: value };
  if (command === 'decide') return { type: 'DECIDE', intent: value };
  if (command === 'act') return { type: 'ACT' };
  if (command === 'verify') return { type: 'VERIFY', changed: value !== 'no' };
  if (command === 'interrupt') return { type: 'INTERRUPT' };
  if (command === 'resume') return { type: 'RESUME' };
  return { type: 'UNKNOWN' };
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
render();
rl.setPrompt('gaming> ');
rl.prompt();
rl.on('line', line => {
  const command = line.trim().toLowerCase();
  if (command === 'quit' || command === 'q') return rl.close();
  if (command !== 'help') state = transition(state, eventFor(line));
  render();
  rl.prompt();
});
rl.on('close', () => process.stdout.write('\n'));
