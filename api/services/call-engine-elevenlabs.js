'use strict';

// ElevenLabs Agents as the voice on Adam's business calls, using their "register call" flow:
// Twilio places the call from Adam's own number; when it is answered, Twilio asks Adam what to do,
// and Adam registers the call with ElevenLabs and hands back the TwiML ElevenLabs returns. So the
// number, status callbacks and callback forwarding stay Adam's, and each call carries its own
// brief and fixed opening line as conversation overrides.
//
// Docs: /v1/convai/twilio/register-call, /v1/convai/conversations, /v1/convai/agents/create.

const API = () => String(process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');

function engineError(message, status) {
  const error = new Error(message);
  error.code = 'call_engine';
  error.status = status;
  return error;
}

function apiKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw engineError('ELEVENLABS_API_KEY is not set.');
  return key;
}

async function request(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${API()}${path}`, {
    method,
    headers: { 'xi-api-key': apiKey(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) throw engineError(`ElevenLabs ${method} ${path.split('?')[0]} returned ${response.status}: ${text.slice(0, 200)}`, response.status);
  return text;
}

function configured() {
  return Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID);
}

// Returns the TwiML that connects the answered call to the agent.
async function registerCall({ from, to, brief, firstMessage, maxSeconds, callId, fetchImpl }) {
  const text = await request('/v1/convai/twilio/register-call', {
    method: 'POST',
    fetchImpl,
    body: {
      agent_id: process.env.ELEVENLABS_AGENT_ID,
      from_number: from,
      to_number: to,
      direction: 'outbound',
      conversation_initiation_client_data: {
        conversation_config_override: {
          agent: { prompt: { prompt: brief }, first_message: firstMessage },
          conversation: { max_duration_seconds: maxSeconds }
        },
        dynamic_variables: { adam_call_id: callId }
      }
    }
  });
  // Documented as a JSON string; accept bare TwiML too.
  let twiml = text;
  try { const parsed = JSON.parse(text); if (typeof parsed === 'string') twiml = parsed; } catch { /* already TwiML */ }
  if (!/<Response[\s>]/.test(twiml)) throw engineError('ElevenLabs did not return TwiML for the call.');
  return twiml;
}

// The ElevenLabs conversation for a Twilio call, once its processing has finished. Returns
// { pending: true } while it is still being written, or null if no conversation exists for the call.
async function findConversation({ callSid, sinceUnix, fetchImpl }) {
  const query = new URLSearchParams({ agent_id: process.env.ELEVENLABS_AGENT_ID, call_start_after_unix: String(Math.floor(sinceUnix)), page_size: '30' });
  const list = JSON.parse(await request(`/v1/convai/conversations?${query}`, { fetchImpl }));
  for (const item of list.conversations || []) {
    const details = JSON.parse(await request(`/v1/convai/conversations/${encodeURIComponent(item.conversation_id)}`, { fetchImpl }));
    if (details?.metadata?.phone_call?.call_sid !== callSid) continue;
    if (details.status !== 'done' && details.status !== 'failed') return { pending: true };
    return {
      conversationId: details.conversation_id,
      seconds: Number(details.metadata?.call_duration_secs) || 0,
      transcript: (details.transcript || [])
        .filter(turn => turn?.message)
        .map(turn => ({ speaker: turn.role === 'agent' ? 'adam' : 'them', text: String(turn.message).trim() })),
      summary: details.analysis?.transcript_summary || null,
      terminationReason: details.metadata?.termination_reason || null
    };
  }
  return null;
}

// The agent every call is registered against: phone audio (μ-law 8 kHz) both ways, end-call and
// voicemail tools, and overrides switched on only for what Adam sets per call.
function agentDefinition({ name = 'Adam business calls', voiceId, llm = 'gpt-5.4-mini', maxSeconds = 390 } = {}) {
  return {
    name,
    tags: ['adam'],
    conversation_config: {
      asr: { user_input_audio_format: 'ulaw_8000' },
      tts: { agent_output_audio_format: 'ulaw_8000', ...(voiceId ? { voice_id: voiceId } : {}) },
      conversation: { max_duration_seconds: maxSeconds },
      agent: {
        first_message: '',
        language: 'en',
        prompt: {
          prompt: 'Each call supplies its own brief. Without one, say this line is not configured and end the call.',
          llm,
          temperature: 0.3,
          built_in_tools: {
            end_call: { name: 'end_call', params: { system_tool_type: 'end_call' } },
            voicemail_detection: { name: 'voicemail_detection', params: { system_tool_type: 'voicemail_detection' } }
          }
        }
      }
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { first_message: true, prompt: { prompt: true } },
          conversation: { max_duration_seconds: true }
        }
      }
    }
  };
}

async function createAgent(options = {}, fetchImpl) {
  return JSON.parse(await request('/v1/convai/agents/create', { method: 'POST', body: agentDefinition(options), fetchImpl })).agent_id;
}

module.exports = { agentDefinition, configured, createAgent, findConversation, registerCall };
