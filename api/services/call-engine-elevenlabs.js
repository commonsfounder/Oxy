'use strict';

// ElevenLabs Agents as the whole phone side of Adam's business calls. The phone number is bought
// once from Twilio and imported into ElevenLabs (scripts/setup-calls.js does it); after that Adam
// only talks to ElevenLabs: it places calls with their outbound-call API, follows each conversation
// by id until it is written, and answers ElevenLabs' webhook when someone rings the number back.
//
// API: /v1/convai/twilio/outbound-call, /v1/convai/conversations/{id}, /v1/convai/agents/create,
// /v1/convai/phone-numbers. Request bodies were checked against ElevenLabs' published OpenAPI spec.

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
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) throw engineError(`ElevenLabs ${method} ${path.split('?')[0]} returned ${response.status}: ${text.slice(0, 300)}`, response.status);
  return text ? JSON.parse(text) : {};
}

function configured() {
  return Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID && process.env.ELEVENLABS_PHONE_NUMBER_ID);
}

// Every dynamic variable the agent uses must be supplied on every conversation, so both directions
// pass both: forward_to is empty on outbound calls (Adam never transfers a business it rang).
function clientData({ prompt, firstMessage, maxSeconds, forwardTo = '', callId = '' }) {
  return {
    conversation_config_override: {
      agent: { prompt: { prompt }, first_message: firstMessage },
      ...(maxSeconds ? { conversation: { max_duration_seconds: maxSeconds } } : {})
    },
    dynamic_variables: { forward_to: forwardTo, adam_call_id: callId }
  };
}

async function placeCall({ to, brief, firstMessage, maxSeconds, callId, fetchImpl }) {
  const result = await request('/v1/convai/twilio/outbound-call', {
    method: 'POST',
    fetchImpl,
    body: {
      agent_id: process.env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: to,
      conversation_initiation_client_data: clientData({ prompt: brief, firstMessage, maxSeconds, callId })
    }
  });
  if (!result.success || !result.conversation_id) throw engineError(result.message || 'ElevenLabs did not start the call.');
  return { conversationId: result.conversation_id, callSid: result.callSid || null };
}

// { pending: true } until ElevenLabs has finished writing the conversation.
async function getConversation({ conversationId, fetchImpl }) {
  const details = await request(`/v1/convai/conversations/${encodeURIComponent(conversationId)}`, { fetchImpl });
  if (details.status !== 'done' && details.status !== 'failed') return { pending: true };
  return {
    conversationId,
    failed: details.status === 'failed',
    seconds: Number(details.metadata?.call_duration_secs) || 0,
    terminationReason: details.metadata?.termination_reason || null,
    transcript: (details.transcript || [])
      .filter(turn => turn?.message)
      .map(turn => ({ speaker: turn.role === 'agent' ? 'adam' : 'them', text: String(turn.message).trim() }))
  };
}

const INBOUND_FALLBACK_PROMPT = 'You answer the phone line Adam, an AI assistant, uses to make calls for people. ' +
  'Say this number only makes calls on behalf of Adam\'s users and cannot take enquiries, then end the call politely.';

// The agent behind both directions: phone audio (μ-law 8 kHz) both ways; end-call and voicemail
// tools (nothing is left on voicemail); a transfer to {{forward_to}}, which is only ever set on
// callbacks Adam has matched to one person; overrides allowed only for the prompt, opening line and
// duration; and ElevenLabs asks Adam's webhook who is calling before answering a callback.
function agentDefinition({ name = 'Adam calls', voiceId, llm = 'gpt-5.4-mini', maxSeconds = 390, webhookUrl, webhookSecret } = {}) {
  return {
    name,
    tags: ['adam'],
    conversation_config: {
      asr: { user_input_audio_format: 'ulaw_8000' },
      tts: { agent_output_audio_format: 'ulaw_8000', ...(voiceId ? { voice_id: voiceId } : {}) },
      conversation: { max_duration_seconds: maxSeconds },
      agent: {
        first_message: 'Hello, this is Adam, an AI assistant.',
        language: 'en',
        prompt: {
          prompt: INBOUND_FALLBACK_PROMPT,
          llm,
          temperature: 0.3,
          built_in_tools: {
            end_call: { name: 'end_call', params: { system_tool_type: 'end_call' } },
            voicemail_detection: { name: 'voicemail_detection', params: { system_tool_type: 'voicemail_detection' } },
            transfer_to_number: {
              name: 'transfer_to_number',
              params: {
                system_tool_type: 'transfer_to_number',
                transfers: [{
                  transfer_destination: { type: 'phone_dynamic_variable', phone_number: '{{forward_to}}' },
                  condition: 'Only when the system prompt says this is a callback that may be put through, the caller wants to speak to the person, and forward_to is not empty. Never on calls Adam placed.',
                  transfer_type: 'conference'
                }]
              }
            }
          }
        }
      }
    },
    platform_settings: {
      overrides: {
        enable_conversation_initiation_client_data_from_webhook: true,
        conversation_config_override: {
          agent: { first_message: true, prompt: { prompt: true } },
          conversation: { max_duration_seconds: true }
        }
      },
      ...(webhookUrl ? {
        workspace_overrides: {
          conversation_initiation_client_data_webhook: { url: webhookUrl, request_headers: { 'x-adam-webhook-secret': webhookSecret } }
        }
      } : {})
    }
  };
}

async function createAgent(options = {}, fetchImpl) {
  return (await request('/v1/convai/agents/create', { method: 'POST', body: agentDefinition(options), fetchImpl })).agent_id;
}

// Imports a Twilio number into ElevenLabs (ElevenLabs configures the number's Twilio webhooks
// itself) and points it at the agent for both directions.
async function importTwilioNumber({ phoneNumber, sid, token, agentId, label = 'Adam', fetchImpl }) {
  const created = await request('/v1/convai/phone-numbers', {
    method: 'POST', fetchImpl,
    body: { provider: 'twilio', phone_number: phoneNumber, label, sid, token, supports_inbound: true, supports_outbound: true }
  });
  await request(`/v1/convai/phone-numbers/${encodeURIComponent(created.phone_number_id)}`, { method: 'PATCH', fetchImpl, body: { agent_id: agentId } });
  return created.phone_number_id;
}

module.exports = { INBOUND_FALLBACK_PROMPT, agentDefinition, clientData, configured, createAgent, getConversation, importTwilioNumber, placeCall };
