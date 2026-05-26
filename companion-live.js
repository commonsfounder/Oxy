const { performance } = require('perf_hooks');
const { WebSocketServer } = require('ws');
const { GoogleGenAI, Modality } = require('@google/genai');
const { dispatch } = require('./connectors');
const { createSupabaseServiceClient } = require('./runtime');
const { verifySignedPayload } = require('./auth');

const supabase = createSupabaseServiceClient();

const COMPANION_LIVE_PATH = '/companion-live';
const COMPANION_LIVE_MODEL = process.env.OXY_COMPANION_LIVE_MODEL
  || process.env.OXY_LIVE_MODEL
  || (String(process.env.GOOGLE_GENAI_USE_ENTERPRISE || '').toLowerCase() === 'true'
    ? 'gemini-live-2.5-flash-preview-native-audio'
    : 'gemini-live-2.5-flash-preview');

const LIVE_VOICE_SET = new Set([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
]);

const LIVE_FUNCTION_DECLARATIONS = [
  {
    name: 'create_reminder',
    description: 'Create a reminder for the user.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due_date: { type: 'string' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'send_email',
    description: 'Send an email on the user\'s behalf.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' }
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'get_emails',
    description: 'Get recent emails for the user.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        max_results: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search_emails',
    description: 'Search the user\'s email inbox.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'create_calendar_event',
    description: 'Create a calendar event.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' }
      },
      required: ['title', 'start_date'],
      additionalProperties: false
    }
  },
  {
    name: 'get_calendar_events',
    description: 'Get upcoming calendar events.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        max_results: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'book_uber',
    description: 'Open an Uber ride flow to a destination.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string' }
      },
      required: ['destination'],
      additionalProperties: false
    }
  },
  {
    name: 'send_telegram',
    description: 'Send a Telegram message.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string' },
        message: { type: 'string' }
      },
      required: ['contact', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'get_telegram_contacts',
    description: 'List Telegram contacts.',
    parametersJsonSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'search_trains',
    description: 'Search live trains between two stations.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string' },
        destination: { type: 'string' }
      },
      required: ['origin', 'destination'],
      additionalProperties: false
    }
  },
  {
    name: 'order_uber_eats',
    description: 'Open an Uber Eats handoff for a dish, cuisine, or restaurant.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        restaurant: { type: 'string' },
        item: { type: 'string' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'order_deliveroo',
    description: 'Open a Deliveroo handoff for a dish, cuisine, or restaurant.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        restaurant: { type: 'string' },
        item: { type: 'string' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'search_netflix_title',
    description: 'Search for a Netflix title.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'add_to_netflix_list',
    description: 'Open the flow to add a Netflix title to the user\'s list.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' }
      },
      required: ['title'],
      additionalProperties: false
    }
  }
];

function createLiveClient() {
  const useEnterprise = String(process.env.GOOGLE_GENAI_USE_ENTERPRISE || '').toLowerCase() === 'true'
    || (!!process.env.GOOGLE_CLOUD_PROJECT && !!process.env.GOOGLE_CLOUD_LOCATION);

  if (useEnterprise) {
    return new GoogleGenAI({
      enterprise: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
      apiVersion: process.env.GOOGLE_GENAI_API_VERSION || 'v1beta'
    });
  }

  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    apiVersion: process.env.GOOGLE_GENAI_API_VERSION || 'v1beta'
  });
}

function createPrototypeTrace(label, socket) {
  const startedAt = performance.now();
  const prefix = `[trace:${label}]`;
  const sentMilestones = new Set();

  return {
    elapsed() {
      return Math.round(performance.now() - startedAt);
    },
    log(step, extra = '') {
      const suffix = extra ? ` ${extra}` : '';
      console.log(`${prefix} +${this.elapsed()}ms ${step}${suffix}`);
    },
    telemetry(stage, extra = {}) {
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify({
        type: 'telemetry',
        stage,
        elapsedMs: this.elapsed(),
        ...extra
      }));
    },
    milestone(stage, extra = {}) {
      if (sentMilestones.has(stage)) return;
      sentMilestones.add(stage);
      this.telemetry(stage, extra);
    }
  };
}

function sendSocketEvent(socket, payload) {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(payload));
}

function sendStatus(socket, status, label, extra = {}) {
  sendSocketEvent(socket, { type: 'status', status, label, ...extra });
}

function createSocketError(socket, error) {
  sendSocketEvent(socket, {
    type: 'error',
    error: error?.message || String(error || 'Unknown companion live error')
  });
}

function writeUnauthorized(socket) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

function getInputMimeType(mimeType = '') {
  const normalized = String(mimeType || '').toLowerCase();
  const rateMatch = normalized.match(/(?:rate|sample_rate)=([0-9]+)/);
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 16000;
  if (normalized.includes('audio/l16')) return `audio/l16;rate=${sampleRate}`;
  if (normalized.includes('audio/pcm')) return `audio/l16;rate=${sampleRate}`;
  if (normalized.startsWith('audio/')) return normalized;
  return `audio/l16;rate=${sampleRate}`;
}

function normalizeVoiceName(voiceName) {
  return LIVE_VOICE_SET.has(voiceName) ? voiceName : 'Aoede';
}

function mergeTranscript(previous, next) {
  const prev = String(previous || '').trim();
  const incoming = String(next || '').trim();
  if (!incoming) return prev;
  if (!prev) return incoming;
  if (incoming === prev) return prev;
  if (incoming.startsWith(prev)) return incoming;
  if (prev.startsWith(incoming)) return prev;

  const maxOverlap = Math.min(prev.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (prev.slice(-overlap) === incoming.slice(0, overlap)) {
      return `${prev}${incoming.slice(overlap)}`;
    }
  }
  return `${prev} ${incoming}`.replace(/\s+/g, ' ').trim();
}

function extractTextFromConversationContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content !== 'object') return String(content);
  return typeof content.text === 'string' ? content.text : '';
}

function serializeConversationContent(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return String(payload);

  const next = {};
  if (typeof payload.text === 'string') next.text = payload.text;
  if (Array.isArray(payload.actions) && payload.actions.length) next.actions = payload.actions;
  return Object.keys(next).length === 1 && typeof next.text === 'string'
    ? next.text
    : JSON.stringify(next);
}

async function saveMessage(userId, role, content) {
  await supabase.from('conversations').insert({
    user_id: userId,
    role,
    content: serializeConversationContent(content),
    created_at: new Date().toISOString()
  });
}

async function logAction(userId, action, input, result) {
  await supabase.from('action_log').insert({
    user_id: userId,
    action,
    input,
    result,
    status: result?.success === false ? 'failed' : 'executed',
    error: result?.success === false ? result.error || result.text || 'Action failed' : null,
    created_at: new Date().toISOString()
  });
}

async function getUserContextSnapshot(userId) {
  const [memoriesRes, conversationRes, preferenceRes, connectorRes, actionRes] = await Promise.all([
    supabase
      .from('memories')
      .select('content, source, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(6),
    supabase
      .from('conversations')
      .select('role, content, created_at')
      .eq('user_id', userId)
      .neq('role', 'system')
      .order('created_at', { ascending: false })
      .limit(8),
    supabase
      .from('preferences')
      .select('key, value, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(8),
    supabase
      .from('connectors')
      .select('connector_id, enabled')
      .eq('user_id', userId)
      .eq('enabled', true)
      .order('connector_id', { ascending: true }),
    supabase
      .from('action_log')
      .select('action, status, error, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5)
  ]);

  const memory = Array.isArray(memoriesRes.data) && memoriesRes.data.length
    ? memoriesRes.data
      .map(row => `${row.source === 'manual_profile' ? 'Profile' : 'Memory'}: ${row.content}`)
      .join('\n')
    : '';

  const recentConversation = Array.isArray(conversationRes.data) && conversationRes.data.length
    ? conversationRes.data
      .reverse()
      .map(row => `${row.role === 'user' ? 'User' : 'Oxy'}: ${extractTextFromConversationContent(row.content)}`)
      .filter(Boolean)
      .join('\n')
    : '';

  const preferences = Array.isArray(preferenceRes.data) && preferenceRes.data.length
    ? preferenceRes.data.map(row => `${row.key}: ${row.value}`).join('\n')
    : '';

  const enabledConnectors = Array.isArray(connectorRes.data) && connectorRes.data.length
    ? connectorRes.data.map(row => row.connector_id).join(', ')
    : '';

  const recentActions = Array.isArray(actionRes.data) && actionRes.data.length
    ? actionRes.data
      .map(row => `${row.action}: ${row.status}${row.error ? ` (${row.error})` : ''}`)
      .join('\n')
    : '';

  return {
    memory,
    recentConversation,
    preferences,
    enabledConnectors,
    recentActions
  };
}

function buildCompanionSystemInstruction(snapshot) {
  return [
    'You are Oxy speaking to the user through a companion app in a real-time Gemini Live session.',
    'The session is audio-first: listen, think, act, and respond naturally with short spoken answers.',
    'Gemini Live handles the transcription, reasoning, and speech. Do not narrate internal steps.',
    'The user leads the conversation. Follow what they just said instead of surfacing unrelated stored memory.',
    'Treat memory as background context for understanding. Only mention it when it is directly relevant to the user\'s current question, request, or task.',
    'If the user just greets you or makes a simple check-in, respond naturally to that message and do not bring up unrelated personal context.',
    'If the user asks you to perform an action and a function is available, call the function instead of only describing what you would do.',
    'Google Search grounding is always available in this session. For current events, recent news, companies, public figures, schedules, prices, or anything that may have changed recently, search before answering.',
    'After a successful action such as sending a message, booking something, or creating an event, stop after one clear confirmation sentence.',
    'Do not repeat context you already stated earlier in the same conversation unless the user asks for it again.',
    'Prefer concise, warm spoken replies. For simple conversational questions, keep the response to a maximum of two sentences.',
    snapshot.enabledConnectors ? `Enabled connectors: ${snapshot.enabledConnectors}` : '',
    snapshot.preferences ? `User preferences:\n${snapshot.preferences}` : '',
    snapshot.memory ? `Known user context:\n${snapshot.memory}` : '',
    snapshot.recentActions ? `Recent action outcomes:\n${snapshot.recentActions}` : '',
    snapshot.recentConversation ? `Recent conversation:\n${snapshot.recentConversation}` : ''
  ].filter(Boolean).join('\n\n');
}

function summarizeToolResult(result) {
  if (!result) return 'No result returned.';
  if (result.success === false) return result.error || result.text || 'Action failed.';
  if (typeof result.text === 'string' && result.text.trim()) return result.text.trim();
  if (result.artifact?.summary) return result.artifact.summary;
  return 'Action completed successfully.';
}

async function executeFunctionCalls(userId, functionCalls, socket, trace) {
  const functionResponses = [];
  const actionResults = [];

  for (const call of functionCalls) {
    const name = call.name;
    const input = (call.arguments && typeof call.arguments === 'object') ? call.arguments : {};
    let result;

    sendStatus(socket, 'action_start', humanizeActionLabel(name, 'start'), { action: name });
    trace.log(`tool.start ${name}`);
    trace.telemetry('tool_start', { action: name });

    try {
      const allowedNames = new Set(LIVE_FUNCTION_DECLARATIONS.map(f => f.name));
      result = allowedNames.has(name)
        ? await dispatch(userId, name, input)
        : { success: false, error: `Function "${name}" is not available in this session.` };
    } catch (error) {
      result = { success: false, error: error?.message || `Failed to execute ${name}.` };
    }

    try {
      await logAction(userId, name, input, result);
    } catch (error) {
      trace.log(`action_log.fail ${name}`, error?.message || error);
      console.warn('[companion-live] action_log failed:', error?.message || error);
    }

    sendStatus(socket, 'action_complete', humanizeActionLabel(name, 'complete'), {
      action: name,
      success: result?.success !== false
    });
    trace.log(`tool.complete ${name}`, result?.success === false ? 'failed' : 'ok');
    trace.telemetry('tool_complete', { action: name, success: result?.success !== false });

    actionResults.push({ action: name, result });
    functionResponses.push({
      id: call.id,
      name,
      response: result?.success === false
        ? { error: result.error || result.text || 'Action failed.' }
        : { output: summarizeToolResult(result) }
    });
  }

  return { functionResponses, actionResults };
}

function humanizeActionLabel(action, phase) {
  const map = {
    send_email: 'email',
    get_emails: 'inbox',
    search_emails: 'email search',
    create_calendar_event: 'calendar event',
    get_calendar_events: 'calendar',
    create_reminder: 'reminder',
    book_uber: 'Uber',
    send_telegram: 'Telegram message',
    get_telegram_contacts: 'Telegram contacts',
    search_trains: 'train search',
    order_uber_eats: 'Uber Eats',
    order_deliveroo: 'Deliveroo',
    search_netflix_title: 'Netflix search',
    add_to_netflix_list: 'Netflix list'
  };
  const label = map[action] || action.replace(/_/g, ' ');
  return phase === 'start'
    ? `Working on ${label}`
    : `${label.charAt(0).toUpperCase()}${label.slice(1)} ready`;
}

async function createCompanionLiveSession(userId, voiceName, socket, state) {
  const ai = createLiveClient();
  const snapshot = await getUserContextSnapshot(userId);

  state.trace.log('context.loaded');
  state.trace.telemetry('context_loaded', {
    memoryChars: snapshot.memory.length,
    recentConversationChars: snapshot.recentConversation.length
  });

  return ai.live.connect({
    model: COMPANION_LIVE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        languageCode: 'en-GB',
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: normalizeVoiceName(voiceName)
          }
        }
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: buildCompanionSystemInstruction(snapshot),
      tools: [
        { googleSearch: {} },
        { functionDeclarations: LIVE_FUNCTION_DECLARATIONS }
      ]
    },
    callbacks: {
      onopen: () => {
        state.trace.log('gemini.live.open');
        state.trace.milestone('live_open');
        sendSocketEvent(socket, {
          type: 'session.ready',
          model: COMPANION_LIVE_MODEL,
          voice: normalizeVoiceName(voiceName)
        });
        sendStatus(socket, 'thinking_start', 'Listening');
      },
      onmessage: async (message) => {
        try {
          if (message.serverContent?.inputTranscription?.text) {
            state.userTranscript = mergeTranscript(
              state.userTranscript,
              message.serverContent.inputTranscription.text
            );
            state.trace.milestone('first_user_transcript');
            sendSocketEvent(socket, {
              type: 'transcript.user',
              text: state.userTranscript,
              final: !!message.serverContent.inputTranscription.finished
            });
          }

          if (message.serverContent?.outputTranscription?.text) {
            state.assistantTranscript = mergeTranscript(
              state.assistantTranscript,
              message.serverContent.outputTranscription.text
            );
            state.trace.milestone('first_assistant_transcript');
            sendSocketEvent(socket, {
              type: 'transcript.assistant',
              text: state.assistantTranscript,
              final: !!message.serverContent.outputTranscription.finished
            });
          }

          const parts = message.serverContent?.modelTurn?.parts || [];
          for (const part of parts) {
            if (typeof part.text === 'string' && part.text.trim()) {
              state.assistantTranscript = mergeTranscript(state.assistantTranscript, part.text);
              state.trace.milestone('first_assistant_transcript');
              sendSocketEvent(socket, {
                type: 'transcript.assistant',
                text: state.assistantTranscript,
                final: false
              });
            }
            if (part.inlineData?.data) {
              if (!state.hasStartedSpeaking) {
                state.hasStartedSpeaking = true;
                sendStatus(socket, 'speaking_start', 'Speaking');
                state.trace.milestone('first_assistant_audio');
              }
              sendSocketEvent(socket, {
                type: 'audio',
                data: part.inlineData.data,
                mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000'
              });
            }
          }

          if (message.toolCall?.functionCalls?.length) {
            const { functionResponses, actionResults } = await executeFunctionCalls(userId, message.toolCall.functionCalls, socket, state.trace);
            if (actionResults.length) {
              state.actionResults.push(...actionResults);
              sendSocketEvent(socket, { type: 'actions', results: actionResults });
            }
            if (state.session) {
              try {
                await state.session.sendToolResponse({ functionResponses });
              } catch (error) {
                state.trace.log('tool_response.fail', error?.message || error);
                console.warn('[companion-live] sendToolResponse failed:', error?.message || error);
              }
            } else {
              state.trace.log('tool_response.skip session_closed');
            }
          }

          if (message.serverContent?.interrupted) {
            sendSocketEvent(socket, { type: 'interrupted' });
          }

          if (message.serverContent?.turnComplete) {
            const userText = state.userTranscript.trim();
            const assistantText = state.assistantTranscript.trim();
            const actionResults = state.actionResults.slice();
            if (userText) saveMessage(userId, 'user', userText).catch(() => {});
            if (assistantText || actionResults.length) {
              saveMessage(userId, 'assistant', { text: assistantText, actions: actionResults }).catch(() => {});
            }
            state.trace.milestone('turn_complete');
            sendSocketEvent(socket, { type: 'turn.complete' });
            state.userTranscript = '';
            state.assistantTranscript = '';
            state.actionResults = [];
            state.hasStartedSpeaking = false;
          }
        } catch (error) {
          createSocketError(socket, error);
        }
      },
      onerror: error => {
        state.trace.log('gemini.live.error', error?.error?.message || error?.message || String(error));
        createSocketError(socket, error?.error || error);
      },
      onclose: () => {
        state.trace.log('gemini.live.closed');
        sendSocketEvent(socket, { type: 'session.closed' });
      }
    }
  });
}

async function flushPendingAudio(state) {
  while (state.pendingEvents.length > 0 && state.session) {
    const event = state.pendingEvents.shift();
    if (event.type === 'audio.append') {
      const bytes = Buffer.from(event.data || '', 'base64');
      state.session.sendRealtimeInput({
        audio: new Blob([bytes], { type: getInputMimeType(event.mimeType) })
      });
      continue;
    }
    if (event.type === 'audio.end') {
      state.session.sendRealtimeInput({ audioStreamEnd: true });
    }
  }
}

function attachCompanionLivePrototypeServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== COMPANION_LIVE_PATH) return;
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', socket => {
    const state = {
      userId: null,
      authenticated: false,
      trace: createPrototypeTrace(`companion-live:${Date.now()}`, socket),
      session: null,
      sessionPromise: null,
      userTranscript: '',
      assistantTranscript: '',
      actionResults: [],
      pendingEvents: [],
      hasStartedSpeaking: false
    };

    state.trace.log('socket.connected');
    sendSocketEvent(socket, { type: 'session.connecting', path: COMPANION_LIVE_PATH });

    const authTimeout = setTimeout(() => {
      if (!state.authenticated) {
        createSocketError(socket, 'Unauthorized');
        socket.close();
      }
    }, 5000);

    socket.on('message', async raw => {
      try {
        if (Buffer.byteLength(raw) > 512 * 1024) {
          createSocketError(socket, 'Companion live message too large.');
          socket.close();
          return;
        }
        const event = JSON.parse(String(raw));

        if (event.type === 'auth') {
          const payload = verifySignedPayload(event.token || '');
          if (!payload || payload.type !== 'session' || !payload.userId) {
            createSocketError(socket, 'Unauthorized');
            socket.close();
            return;
          }
          state.userId = payload.userId;
          state.authenticated = true;
          clearTimeout(authTimeout);
          state.trace.log('auth.ok', payload.userId);
          state.trace.milestone('auth_ok');
          sendSocketEvent(socket, { type: 'session.authenticated', userId: payload.userId });
          return;
        }

        if (!state.authenticated) {
          createSocketError(socket, 'Unauthorized');
          socket.close();
          return;
        }

        if (event.type === 'session.start') {
          if (!state.session && !state.sessionPromise) {
            state.trace.log('session.start');
            state.trace.milestone('session_start');
            state.sessionPromise = createCompanionLiveSession(state.userId, event.voice, socket, state)
              .then(async session => {
                state.session = session;
                state.sessionPromise = null;
                await flushPendingAudio(state);
                return session;
              })
              .catch(error => {
                state.sessionPromise = null;
                createSocketError(socket, error);
                throw error;
              });
          }
          return;
        }

        if (!state.session) {
          if (state.sessionPromise && (event.type === 'audio.append' || event.type === 'audio.end')) {
            if (state.pendingEvents.length >= 50) {
              createSocketError(socket, 'Companion live: too many pending audio events.');
              socket.close();
              return;
            }
            state.pendingEvents.push(event);
            return;
          }
          createSocketError(socket, 'Companion live session has not been started yet.');
          return;
        }

        if (event.type === 'audio.append') {
          const bytes = Buffer.from(event.data || '', 'base64');
          state.session.sendRealtimeInput({
            audio: new Blob([bytes], { type: getInputMimeType(event.mimeType) })
          });
          return;
        }

        if (event.type === 'audio.end') {
          state.trace.log('audio.end');
          state.trace.milestone('audio_end');
          state.session.sendRealtimeInput({ audioStreamEnd: true });
          return;
        }

        if (event.type === 'session.stop') {
          if (state.session) {
            state.session.close();
            state.session = null;
          } else if (state.sessionPromise) {
            state.sessionPromise.then(session => { try { session?.close(); } catch {} }).catch(() => {});
            state.sessionPromise = null;
          }
        }
      } catch (error) {
        createSocketError(socket, error);
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
      try {
        state.session?.close();
      } catch {}
      state.trace.log('socket.closed');
      state.pendingEvents = [];
      state.session = null;
      state.sessionPromise = null;
    });
  });

  return wss;
}

module.exports = {
  attachCompanionLivePrototypeServer
};
