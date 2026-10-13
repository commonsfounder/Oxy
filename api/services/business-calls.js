'use strict';

// Adam phoning a business for someone: place the call, connect its audio to the voice model, and
// tell the person what happened. Calls live in memory for their few minutes; the durable record is
// what gets written when they end (the chat message, the notification, the action log).

const crypto = require('node:crypto');
const axios = require('axios');
const {
  DAILY_CALL_CAP, MAX_CALL_SECONDS, buildCallBrief, describeOutcome, disclosureLine, validateCallRequest
} = require('./business-call');
const { bridgeCall } = require('./call-bridge');

const calls = new Map();
const MEDIA_PATH = /^\/calls\/media\/([a-f0-9]{32})\/([a-f0-9]{64})$/;
let runtime = null;

// saveMessage(userId, role, content), raise(userId, notification), countCallsToday(userId), findCallback(e164),
// openRealtime() -> WebSocket, twilio: { create(params), hangUp(callSid) }.
function configure(deps) {
  runtime = { ...deps };
}

function secret() {
  const value = process.env.OXY_SESSION_SECRET;
  if (!value) throw new Error('OXY_SESSION_SECRET is required to place calls.');
  return value;
}

function mediaToken(callId) {
  return crypto.createHmac('sha256', secret()).update(`call-media:${callId}`).digest('hex');
}

function callError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function twilioCredentials() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw callError('not_configured', 'Phone calls are not set up on this server.');
  return { sid, token };
}

const twilioRest = {
  async create(params) {
    const { sid, token } = twilioCredentials();
    const response = await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
      new URLSearchParams(params), { auth: { username: sid, password: token }, timeout: 15000 });
    return { callSid: response.data?.sid || null };
  },
  async hangUp(callSid) {
    if (!callSid) return;
    const { sid, token } = twilioCredentials();
    await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`,
      new URLSearchParams({ Status: 'completed' }), { auth: { username: sid, password: token }, timeout: 10000 });
  }
};

function openAiRealtime() {
  const WebSocket = require('ws');
  const model = process.env.OXY_REALTIME_MODEL || 'gpt-realtime';
  return new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  });
}

function xmlAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function startCall({ userId, input, fromNumber, baseUrl, onBehalfOf }) {
  if (!runtime) throw new Error('business calls are not configured');
  const request = validateCallRequest(input);
  if (!fromNumber) throw callError('no_number', 'Adam does not have a phone number set up yet.');
  if (!/^https:\/\//.test(baseUrl || '')) throw callError('not_configured', 'Calls need the server\'s public https address (APP_URL).');
  const made = await (runtime.countCallsToday || (async () => 0))(userId);
  if (made >= DAILY_CALL_CAP) throw callError('cap', `Adam has made ${DAILY_CALL_CAP} calls today, the most it will make in a day.`);

  const id = crypto.randomBytes(16).toString('hex');
  const who = String(onBehalfOf || '').trim() || 'a customer';
  const call = {
    id, userId, request,
    brief: buildCallBrief(request, { onBehalfOf: who }),
    disclosure: disclosureLine(who),
    callSid: null,
    reported: false,
    createdAt: Date.now()
  };
  calls.set(id, call);
  const host = baseUrl.replace(/^https:\/\//, '').replace(/\/+$/, '');
  const twiml = `<Response><Connect><Stream url="${xmlAttr(`wss://${host}/calls/media/${id}/${mediaToken(id)}`)}"/></Connect></Response>`;
  try {
    const { callSid } = await (runtime.twilio || twilioRest).create({
      To: request.phone,
      From: fromNumber,
      Twiml: twiml,
      TimeLimit: String(MAX_CALL_SECONDS + 30),
      Timeout: '30',
      StatusCallback: `${baseUrl.replace(/\/+$/, '')}/webhooks/calls/${id}/status`,
      StatusCallbackEvent: 'completed',
      StatusCallbackMethod: 'POST'
    });
    call.callSid = callSid;
  } catch (error) {
    calls.delete(id);
    throw callError('call_failed', `I couldn't place the call: ${error.response?.data?.message || error.message}`);
  }
  // A call Twilio never reports back on must not sit in memory forever.
  setTimeout(() => report(call, { outcome: null, endedBy: 'unknown', seconds: 0 }), (MAX_CALL_SECONDS + 180) * 1000).unref?.();
  return { id, request };
}

async function report(call, { outcome, endedBy, seconds, transcript = [] }) {
  if (!call || call.reported) return;
  call.reported = true;
  calls.delete(call.id);
  const message = describeOutcome({ businessName: call.request.businessName, outcome, endedBy, seconds });
  const heard = transcript.slice(-12).map(line => `${line.speaker === 'adam' ? 'Adam' : 'Them'}: ${line.text}`).join('\n');
  try {
    await runtime.saveMessage(call.userId, 'assistant', {
      text: `${message.title}. ${message.body}`,
      call: { business: call.request.businessName, phone: call.request.phone, status: message.status, transcript: heard || null }
    });
  } catch { /* still notify */ }
  try {
    await runtime.raise(call.userId, {
      category: message.needsYou ? 'action_required' : 'other',
      title: message.title,
      body: message.body,
      dedupeKey: `business-call:${call.id}`,
      sourceRef: { businessCallId: call.id, status: message.status }
    });
  } catch { /* the chat message is the record */ }
}

// Twilio: X-Twilio-Signature = base64(HMAC-SHA1(auth token, url + each param name+value, sorted by name)).
function validTwilioSignature(url, params, signature, token = process.env.TWILIO_AUTH_TOKEN) {
  if (!token || !signature) return false;
  const data = Object.keys(params || {}).sort().reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', token).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleStatus(callId, params) {
  const call = calls.get(callId);
  if (!call) return;
  const status = String(params?.CallStatus || '');
  const endedBy = { 'no-answer': 'no_answer', busy: 'busy', failed: 'failed', canceled: 'failed' }[status];
  // A completed call is reported by the bridge when its audio stream ends; this only covers calls
  // that never connected.
  if (endedBy && !call.bridged) await report(call, { outcome: null, endedBy, seconds: 0 });
}

// action_log.action is a jsonb column holding the JSON text written by serializeLoggedAction, so
// rows are matched here rather than with a SQL LIKE (which Postgres refuses on jsonb).
function loggedCall(row) {
  let value = row?.action;
  try { if (typeof value === 'string') value = JSON.parse(value); } catch { return null; }
  return value?.type === 'call_business' ? value : null;
}

function callsInLog(rows) {
  return (rows || []).map(loggedCall).filter(Boolean);
}

// Newest-first action_log rows -> who this number was called for. More than one person: ambiguous.
function callbackFromLog(rows, caller) {
  const hits = (rows || []).filter(row => String(loggedCall(row)?.resultText || '').includes(`(${caller})`));
  const users = [...new Set(hits.map(row => row.user_id))];
  if (users.length !== 1) return users.length ? { ambiguous: true } : null;
  return { userId: users[0], businessName: loggedCall(hits[0]).input?.business_name || null };
}

function say(text) {
  return `<Say>${xmlAttr(text)}</Say>`;
}

// Someone rang Adam's shared number. If it is a business Adam called for exactly one person
// recently, they are put through to that person's own phone (shown as Adam's number, so the
// person's number is never revealed) and the person is told who is calling. Anything else gets a
// short spoken explanation; nothing is recorded.
//
// runtime.findCallback(callerE164) -> { userId, businessName, userPhone } | { ambiguous: true } | null
async function handleInboundCall({ from }) {
  const NOT_FOR_YOU = say('This number is used by Adam, an AI assistant, to make calls for people. It cannot take calls. Goodbye.');
  let caller;
  try { caller = (require('./business-call')).normalizeCallNumber(from); } catch { return `<Response>${NOT_FOR_YOU}</Response>`; }
  const match = await (runtime?.findCallback || (async () => null))(caller).catch(() => null);
  if (!match || match.ambiguous) return `<Response>${NOT_FOR_YOU}</Response>`;

  let userPhone = null;
  try { userPhone = match.userPhone ? (require('./business-call')).normalizeCallNumber(match.userPhone) : null; } catch { userPhone = null; }
  const business = match.businessName || caller;
  await runtime.raise(match.userId, {
    category: 'action_required',
    title: `${business} is calling back`,
    body: userPhone
      ? `They rang Adam's number about your request. Putting them through to you now from ${process.env.TWILIO_PHONE_NUMBER || 'Adam\'s number'}.`
      : `They rang Adam's number about your request. Call them back on ${caller}. Add your phone number in Settings and Adam will put callbacks through to you.`,
    dedupeKey: `business-callback:${caller}:${Math.floor(Date.now() / 60000)}`,
    sourceRef: { businessCallback: caller }
  }).catch(() => {});

  if (!userPhone) {
    return `<Response>${say('Thanks for calling back. They have been told you called and will ring you back. Goodbye.')}</Response>`;
  }
  const callerId = process.env.TWILIO_PHONE_NUMBER ? ` callerId="${xmlAttr(process.env.TWILIO_PHONE_NUMBER)}"` : '';
  return `<Response>${say('Thanks for calling back. Connecting you now.')}<Dial timeout="25"${callerId}><Number>${xmlAttr(userPhone)}</Number></Dial>${say('They could not answer. They have been told you called. Goodbye.')}</Response>`;
}

// For the HTTP server's 'upgrade' event. Returns false when the path isn't a call stream.
function handleUpgrade(req, socket, head) {
  const match = MEDIA_PATH.exec(String(req.url || '').split('?')[0]);
  if (!match) return false;
  const [, callId, token] = match;
  const call = calls.get(callId);
  const expected = Buffer.from(mediaToken(callId));
  if (!call || call.bridged || token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), expected)) {
    socket.destroy();
    return true;
  }
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  wss.handleUpgrade(req, socket, head, twilioSocket => {
    call.bridged = true;
    bridgeCall({
      twilio: twilioSocket,
      realtime: (runtime.openRealtime || openAiRealtime)(),
      brief: call.brief,
      disclosure: call.disclosure,
      onHangup: () => (runtime.twilio || twilioRest).hangUp(call.callSid).catch(() => {}),
      onFinished: result => report(call, result)
    });
  });
  return true;
}

module.exports = {
  configure,
  startCall,
  callsInLog,
  callbackFromLog,
  handleInboundCall,
  handleStatus,
  handleUpgrade,
  validTwilioSignature,
  _calls: calls,
  _mediaToken: mediaToken
};
