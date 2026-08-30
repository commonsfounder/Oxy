'use strict';

// PROTOTYPE: pure cross-platform game-session state machine. No I/O belongs here.

const PLATFORMS = Object.freeze({
  pc_keyboard: {
    label: 'PC · keyboard/mouse', observation: 'direct screen capture', input: 'keyboard/mouse', bridgeRequired: false
  },
  pc_gamepad: {
    label: 'PC · controller', observation: 'direct screen capture', input: 'virtual gamepad', bridgeRequired: false
  },
  ps5: {
    label: 'PlayStation 5', observation: 'HDMI capture or approved remote stream', input: 'controller bridge', bridgeRequired: true
  },
  xbox: {
    label: 'Xbox', observation: 'HDMI capture or approved remote stream', input: 'controller bridge', bridgeRequired: true
  }
});

const MODES = Object.freeze(['observe', 'assist', 'control']);
const SESSION_TYPES = Object.freeze(['single_player', 'local_coop', 'private_multiplayer', 'public_competitive']);
const MAX_HISTORY = 8;

function initialState() {
  return {
    phase: 'disconnected',
    platform: 'pc_keyboard',
    mode: 'control',
    sessionType: 'single_player',
    bridgeReady: false,
    goal: null,
    observation: null,
    proposedAction: null,
    lastOutcome: null,
    framesSeen: 0,
    actionsIssued: 0,
    blockedReason: null,
    pausedFrom: null,
    history: []
  };
}

function withHistory(state, message) {
  return { ...state, history: [...state.history, message].slice(-MAX_HISTORY) };
}

function blocked(state, reason) {
  return withHistory({ ...state, blockedReason: reason }, `Blocked: ${reason}`);
}

function inputAllowed(state) {
  if (state.phase === 'disconnected') return { allowed: false, reason: 'session is disconnected' };
  if (state.phase === 'paused') return { allowed: false, reason: 'session is paused' };
  if (state.mode !== 'control') return { allowed: false, reason: `mode is ${state.mode}` };
  if (state.sessionType === 'public_competitive') {
    return { allowed: false, reason: 'public competitive play is assist-only' };
  }
  if (PLATFORMS[state.platform].bridgeRequired && !state.bridgeReady) {
    return { allowed: false, reason: `${PLATFORMS[state.platform].label} needs a controller bridge` };
  }
  return { allowed: true, reason: null };
}

function transition(current, event = {}) {
  const state = { ...current, blockedReason: null };
  switch (event.type) {
    case 'SELECT_PLATFORM': {
      if (!PLATFORMS[event.platform]) return blocked(state, 'unknown platform');
      return withHistory({
        ...initialState(),
        platform: event.platform,
        mode: state.mode,
        sessionType: state.sessionType,
        bridgeReady: event.platform === 'ps5' || event.platform === 'xbox' ? false : state.bridgeReady
      }, `Selected ${PLATFORMS[event.platform].label}`);
    }
    case 'CONNECT':
      if (state.phase !== 'disconnected') return blocked(state, 'session is already connected');
      return withHistory({ ...state, phase: 'observing' }, `Connected observation adapter: ${PLATFORMS[state.platform].observation}`);
    case 'DISCONNECT':
      return withHistory({ ...initialState(), platform: state.platform, mode: state.mode, sessionType: state.sessionType }, 'Disconnected');
    case 'SET_MODE':
      return MODES.includes(event.mode)
        ? withHistory({ ...state, mode: event.mode }, `Mode: ${event.mode}`)
        : blocked(state, 'mode must be observe, assist, or control');
    case 'SET_SESSION_TYPE':
      return SESSION_TYPES.includes(event.sessionType)
        ? withHistory({ ...state, sessionType: event.sessionType }, `Session type: ${event.sessionType}`)
        : blocked(state, 'unknown session type');
    case 'SET_BRIDGE':
      return withHistory({ ...state, bridgeReady: Boolean(event.ready) }, `Controller bridge: ${event.ready ? 'ready' : 'unavailable'}`);
    case 'SET_GOAL': {
      const goal = String(event.goal || '').trim().slice(0, 160);
      return goal ? withHistory({ ...state, goal, lastOutcome: null }, `Goal: ${goal}`) : blocked(state, 'goal is empty');
    }
    case 'OBSERVE': {
      if (state.phase === 'disconnected' || state.phase === 'paused') return blocked(state, 'connect and remain active before observing');
      const summary = String(event.summary || 'new game frame').trim().slice(0, 240);
      return withHistory({
        ...state,
        phase: state.goal ? 'planning' : 'observing',
        observation: { frame: state.framesSeen + 1, summary },
        framesSeen: state.framesSeen + 1,
        proposedAction: null
      }, `Observed: ${summary}`);
    }
    case 'DECIDE': {
      if (!state.goal) return blocked(state, 'set a game goal before deciding');
      if (!state.observation) return blocked(state, 'observe the current game state before deciding');
      const intent = String(event.intent || 'advance toward the current objective').trim().slice(0, 160);
      return withHistory({
        ...state,
        phase: 'ready',
        proposedAction: {
          intent,
          normalizedInput: { move: [0.65, 0], look: [0.2, -0.1], buttons: ['confirm'] }
        }
      }, `Proposed: ${intent}`);
    }
    case 'ACT': {
      if (!state.proposedAction) return blocked(state, 'there is no proposed action');
      const permission = inputAllowed(state);
      if (!permission.allowed) return blocked(state, permission.reason);
      return withHistory({
        ...state,
        phase: 'verifying',
        actionsIssued: state.actionsIssued + 1,
        lastOutcome: null
      }, `Issued via ${PLATFORMS[state.platform].input}: ${state.proposedAction.intent}`);
    }
    case 'VERIFY': {
      if (state.phase !== 'verifying') return blocked(state, 'issue an input before verifying it');
      const changed = event.changed !== false;
      return withHistory({
        ...state,
        phase: changed ? 'observing' : 'planning',
        lastOutcome: changed ? 'game state changed as intended' : 'input had no verified effect',
        proposedAction: null
      }, changed ? 'Verified state change' : 'Verification failed; re-plan');
    }
    case 'INTERRUPT':
      if (state.phase === 'disconnected' || state.phase === 'paused') return blocked(state, 'nothing active to interrupt');
      return withHistory({ ...state, pausedFrom: state.phase, phase: 'paused' }, 'Paused immediately');
    case 'RESUME':
      if (state.phase !== 'paused') return blocked(state, 'session is not paused');
      return withHistory({ ...state, phase: state.pausedFrom || 'observing', pausedFrom: null }, 'Resumed');
    default:
      return blocked(state, 'unknown event');
  }
}

module.exports = { PLATFORMS, MODES, SESSION_TYPES, initialState, inputAllowed, transition };
