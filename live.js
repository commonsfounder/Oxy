const { WebSocketServer } = require('ws');
const { GoogleGenAI, Modality } = require('@google/genai');
const { dispatch } = require('./connectors');
const { createSupabaseServiceClient } = require('./runtime');
const { verifySignedPayload } = require('./auth');

const supabase = createSupabaseServiceClient();

const LIVE_MODEL = process.env.OXY_LIVE_MODEL
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
    description: 'Send an email on the user’s behalf.',
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
    description: 'Search the user’s email inbox.',
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
    description: 'Open the flow to add a Netflix title to the user’s list.',
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
    name: 'forget_memory',
    description: 'Delete something from Oxy memory.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        query: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'generate_visual',
    description: 'Generate a contextual visual for the conversation.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string' },
        style: { type: 'string' },
        usage: { type: 'string' }
      },
      required: ['brief'],
      additionalProperties: false
    }
  },
  {
    name: 'create_diagram',
    description: 'Create a diagram to explain a topic.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        goal: { type: 'string' }
      },
      required: ['topic'],
      additionalProperties: false
    }
  },
  {
    name: 'create_presentation',
    description: 'Create a short presentation outline with visuals.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        audience: { type: 'string' },
        objective: { type: 'string' },
        slide_count: { type: 'number' }
      },
      required: ['topic'],
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

function createSocketError(socket, error) {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify({ type: 'live-error', error: error?.message || String(error || 'Unknown realtime error') }));
}

function sendSocketEvent(socket, payload) {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(payload));
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
  return LIVE_VOICE_SET.has(voiceName) ? voiceName : 'Schedar';
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
  if (typeof payload.image === 'string') next.image = payload.image;
  if (Array.isArray(payload.actions) && payload.actions.length) next.actions = payload.actions;
  if (typeof payload.audio === 'string') next.audio = payload.audio;
  if (typeof payload.kind === 'string') next.kind = payload.kind;

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

async function getUserMemory(userId) {
  try {
    const { data } = await supabase
      .from('memories')
      .select('content, source, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(6);

    if (!Array.isArray(data) || data.length === 0) return '';
    return data
      .map(row => {
        const prefix = row.source === 'manual_profile' ? 'Profile' : 'Memory';
        return `${prefix}: ${row.content}`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

async function getRecentConversationText(userId) {
  try {
    const { data } = await supabase
      .from('conversations')
      .select('role, content, created_at')
      .eq('user_id', userId)
      .neq('role', 'system')
      .order('created_at', { ascending: false })
      .limit(8);

    if (!Array.isArray(data) || !data.length) return '';
    return data
      .reverse()
      .map(row => `${row.role === 'user' ? 'User' : 'Oxy'}: ${extractTextFromConversationContent(row.content)}`)
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

function buildLiveSystemInstruction(memory, recentConversation) {
  return [
    'You are Oxy, a proactive personal assistant speaking with the user in real time.',
    'Be concise, natural, and useful. Keep spoken replies fairly short unless the user asks for depth.',
    'The user leads the conversation. Follow what they just said instead of surfacing unrelated stored memory.',
    'Treat memory as background context for understanding. Only mention it when it is directly relevant to the user\'s current question, request, or task.',
    'If the user just greets you or makes a simple check-in, respond naturally to that message and do not bring up unrelated personal context.',
    'If the user asks you to do something and a tool is available, call the tool instead of merely describing what you would do.',
    'Google Search grounding is always available in this session. For current events, recent news, companies, public figures, schedules, prices, or anything that may have changed recently, search before answering.',
    'If the user asks you to forget, delete, wipe, or remove something from memory, use forget_memory.',
    'Do not repeat successful past actions unless the user explicitly asks you to repeat them.',
    'If an action fails and the user asks to retry, retry only the failed action unless they ask otherwise.',
    'If information is uncertain, say that plainly rather than guessing.',
    'Do not repeat context you already stated earlier in the current conversation unless the user asks for it again.',
    memory ? `Known user context:\n${memory}` : '',
    recentConversation ? `Recent conversation context:\n${recentConversation}` : ''
  ].filter(Boolean).join('\n\n');
}

function summarizeToolResult(result) {
  if (!result) return 'No result returned.';
  if (result.success === false) return result.error || result.text || 'Action failed.';
  if (typeof result.text === 'string' && result.text.trim()) return result.text.trim();
  if (result.artifact?.summary) return result.artifact.summary;
  return 'Action completed successfully.';
}

async function forgetMemory(userId, args = {}) {
  const scope = String(args.scope || '').toLowerCase();
  const query = String(args.query || '').trim();

  if (scope === 'all') {
    await supabase.from('memories').delete().eq('user_id', userId);
    return { success: true, text: 'I cleared what I had in memory.' };
  }

  if (scope === 'recent') {
    const { data } = await supabase
      .from('memories')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!data?.length) return { success: true, text: 'There was nothing stored to forget.' };
    await supabase.from('memories').delete().eq('id', data[0].id);
    return { success: true, text: 'I forgot the most recent memory.' };
  }

  if (query) {
    const escaped = query.replace(/[\\%_]/g, match => `\\${match}`);
    const { data } = await supabase
      .from('memories')
      .select('id')
      .eq('user_id', userId)
      .ilike('content', `%${escaped}%`);
    if (!data?.length) return { success: true, text: `I couldn't find anything stored about "${query}".` };
    await supabase.from('memories').delete().in('id', data.map(row => row.id));
    return { success: true, text: `I removed what I had stored about "${query}".` };
  }

  return { success: false, error: 'forget_memory needs scope "recent" or "all", or a query.' };
}

async function executeFunctionCalls(userId, functionCalls = []) {
  const functionResponses = [];
  const actionResults = [];

  for (const call of functionCalls) {
    const name = call.name;
    const input = (call.arguments && typeof call.arguments === 'object') ? call.arguments : {};
    let result;

    try {
      result = name === 'forget_memory'
        ? await forgetMemory(userId, input)
        : await dispatch(userId, name, input);
    } catch (error) {
      result = { success: false, error: error?.message || `Failed to execute ${name}.` };
    }

    try {
      await logAction(userId, name, input, result);
    } catch {}

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

async function createLiveSession(userId, voiceName, socket, state) {
  const ai = createLiveClient();
  const [memory, recentConversation] = await Promise.all([
    getUserMemory(userId),
    getRecentConversationText(userId)
  ]);

  return ai.live.connect({
    model: LIVE_MODEL,
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
      systemInstruction: buildLiveSystemInstruction(memory, recentConversation),
      tools: [
        { googleSearch: {} },
        { functionDeclarations: LIVE_FUNCTION_DECLARATIONS }
      ]
    },
    callbacks: {
      onopen: () => {
        sendSocketEvent(socket, { type: 'live-open' });
      },
      onmessage: async message => {
        try {
          if (message.serverContent?.inputTranscription?.text) {
            state.userTranscript = mergeTranscript(
              state.userTranscript,
              message.serverContent.inputTranscription.text
            );
            sendSocketEvent(socket, {
              type: 'user-transcript',
              text: state.userTranscript,
              final: !!message.serverContent.inputTranscription.finished
            });
          }

          if (message.serverContent?.outputTranscription?.text) {
            state.assistantTranscript = mergeTranscript(
              state.assistantTranscript,
              message.serverContent.outputTranscription.text
            );
            sendSocketEvent(socket, {
              type: 'assistant-transcript',
              text: state.assistantTranscript,
              final: !!message.serverContent.outputTranscription.finished
            });
          }

          const parts = message.serverContent?.modelTurn?.parts || [];
          for (const part of parts) {
            if (typeof part.text === 'string' && part.text.trim()) {
              state.assistantTranscript = mergeTranscript(state.assistantTranscript, part.text);
              sendSocketEvent(socket, {
                type: 'assistant-transcript',
                text: state.assistantTranscript,
                final: false
              });
            }
            if (part.inlineData?.data) {
              sendSocketEvent(socket, {
                type: 'assistant-audio',
                data: part.inlineData.data,
                mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000'
              });
            }
          }

          if (message.toolCall?.functionCalls?.length) {
            const { functionResponses, actionResults } = await executeFunctionCalls(userId, message.toolCall.functionCalls);
            if (actionResults.length) {
              state.actionResults.push(...actionResults);
              sendSocketEvent(socket, { type: 'assistant-actions', results: actionResults });
            }
            state.session.sendToolResponse({ functionResponses });
          }

          if (message.serverContent?.interrupted) {
            sendSocketEvent(socket, { type: 'live-interrupted' });
          }

          if (message.serverContent?.turnComplete) {
            const userText = state.userTranscript.trim();
            const assistantText = state.assistantTranscript.trim();
            const actionResults = state.actionResults.slice();
            if (userText) {
              saveMessage(userId, 'user', userText).catch(() => {});
            }
            if (assistantText || actionResults.length) {
              saveMessage(userId, 'assistant', { text: assistantText, actions: actionResults }).catch(() => {});
            }
            sendSocketEvent(socket, { type: 'live-turn-complete' });
            state.userTranscript = '';
            state.assistantTranscript = '';
            state.actionResults = [];
          }
        } catch (error) {
          createSocketError(socket, error);
        }
      },
      onerror: error => {
        createSocketError(socket, error?.error || error);
      },
      onclose: () => {
        sendSocketEvent(socket, { type: 'live-closed' });
      }
    }
  });
}

function writeUnauthorized(socket) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

async function flushPendingAudio(state) {
  while (state.pendingEvents.length > 0 && state.session) {
    const event = state.pendingEvents.shift();
    if (event.type === 'audio-chunk') {
      const bytes = Buffer.from(event.data || '', 'base64');
      state.session.sendRealtimeInput({
        audio: new Blob([bytes], { type: getInputMimeType(event.mimeType) })
      });
      continue;
    }
    if (event.type === 'audio-end') {
      state.session.sendRealtimeInput({ audioStreamEnd: true });
    }
  }
}

function attachRealtimeVoiceServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/realtime-voice') return;
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (socket) => {
    const state = {
      userId: null,
      authenticated: false,
      session: null,
      sessionPromise: null,
      userTranscript: '',
      assistantTranscript: '',
      actionResults: [],
      pendingEvents: []
    };
    const authTimeout = setTimeout(() => {
      if (!state.authenticated) {
        createSocketError(socket, 'Unauthorized');
        socket.close();
      }
    }, 5000);

    socket.on('message', async raw => {
      try {
        if (Buffer.byteLength(raw) > 512 * 1024) {
          createSocketError(socket, 'Realtime message too large.');
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
          sendSocketEvent(socket, { type: 'live-authenticated' });
          return;
        }

        if (!state.authenticated) {
          createSocketError(socket, 'Unauthorized');
          socket.close();
          return;
        }

        if (event.type === 'live-start') {
          if (!state.session && !state.sessionPromise) {
            state.sessionPromise = createLiveSession(state.userId, event.voice, socket, state)
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
          if (state.sessionPromise && (event.type === 'audio-chunk' || event.type === 'audio-end')) {
            state.pendingEvents.push(event);
            return;
          }
          createSocketError(socket, 'Live session has not been started yet.');
          return;
        }

        if (event.type === 'audio-chunk') {
          const bytes = Buffer.from(event.data || '', 'base64');
          state.session.sendRealtimeInput({
            audio: new Blob([bytes], { type: getInputMimeType(event.mimeType) })
          });
          return;
        }

        if (event.type === 'audio-end') {
          state.session.sendRealtimeInput({ audioStreamEnd: true });
          return;
        }

        if (event.type === 'live-stop') {
          state.session.close();
          state.session = null;
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
      state.session = null;
      state.sessionPromise = null;
      state.pendingEvents = [];
    });
  });

  return wss;
}

module.exports = {
  attachRealtimeVoiceServer
};
