const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

process.env.OXY_SESSION_SECRET ||= 'test-secret-test-secret-test-secret';

const {
  buildCallBrief, describeOutcome, disclosureLine, normalizeCallNumber, normalizeOutcome, validateCallRequest
} = require('../../api/services/business-call');
const { bridgeCall, END_MARK } = require('../../api/services/call-bridge');
const businessCalls = require('../../api/services/business-calls');
const { reviewDetailForAction } = require('../../api/services/pending-review');

// --- policy --------------------------------------------------------------------------------

test('numbers: UK local formats become E.164; emergency, short and premium numbers are refused', () => {
  assert.equal(normalizeCallNumber('020 7123 4567'), '+442071234567');
  assert.equal(normalizeCallNumber('07700 900123'), '+447700900123');
  assert.equal(normalizeCallNumber('0044 20 7123 4567'), '+442071234567');
  assert.equal(normalizeCallNumber('+1 (415) 555-0100'), '+14155550100');
  for (const n of ['999', '911', '112', '+999', '111']) assert.throws(() => normalizeCallNumber(n), { code: 'blocked_number' });
  for (const n of ['09012345678', '+449012345678', '+19005550100', '+448712345678']) assert.throws(() => normalizeCallNumber(n), { code: 'blocked_number' });
  for (const n of ['', 'Dishoom', '12345']) assert.throws(() => normalizeCallNumber(n), { code: 'invalid_number' });
});

test('the brief carries the goal and only the listed details, and the hard rules', () => {
  const request = validateCallRequest({
    phone: '020 7123 4567', business_name: 'Dishoom', goal: 'Book a table for 4 on Friday at 7:30pm',
    details: ['Booking name: Sam Patel', 'Party of 4'], fallback: 'Saturday same time'
  });
  const brief = buildCallBrief(request, { onBehalfOf: 'Sam' });
  assert.match(brief, /on behalf of Sam/);
  assert.match(brief, /Book a table for 4 on Friday at 7:30pm/);
  assert.match(brief, /- Booking name: Sam Patel\n- Party of 4/);
  assert.match(brief, /If that is not possible: Saturday same time/);
  assert.match(brief, /Never give or agree to card numbers, deposits, payments/);
  assert.match(brief, /say plainly that you are an AI assistant/);
  assert.match(buildCallBrief({ ...request, details: [] }, { onBehalfOf: 'Sam' }), /none: do not give any personal details/);
  assert.equal(disclosureLine('Sam'), 'Hello, this is Adam, an AI assistant calling on behalf of Sam.');
  assert.throws(() => validateCallRequest({ phone: '02071234567', goal: 'x' }), { code: 'invalid_call' });
});

test('the approval card says who, what for, what Adam may share and what it won\'t do', () => {
  const detail = reviewDetailForAction({ type: 'call_business', input: { business_name: 'Dishoom', phone: '+442071234567', goal: 'Book Friday 7:30', details: ['Name: Sam'] } });
  assert.equal(detail, 'Dishoom · +442071234567\nBook Friday 7:30\nAdam may tell them: Name: Sam\nSays it is an AI assistant. Won\'t pay or commit to anything.');
});

test('outcomes: only reported facts; an offer needs a decision; no report is never success', () => {
  assert.equal(normalizeOutcome('{"status":"made_up","summary":"x"}'), null);
  const offered = describeOutcome({ businessName: 'Dishoom', outcome: normalizeOutcome({ status: 'needs_decision', summary: 'Friday is full.', offer: 'Friday 9:15pm, £10 deposit per person' }), seconds: 95 });
  assert.equal(offered.title, 'Dishoom needs your answer');
  assert.equal(offered.needsYou, true);
  assert.match(offered.body, /They offered: Friday 9:15pm, £10 deposit per person\. Nothing is confirmed until you say so\./);
  const done = describeOutcome({ businessName: 'Dishoom', outcome: normalizeOutcome({ status: 'done', summary: 'Booked for 4 at 7:30 Friday.', reference: 'under Patel' }), seconds: 130 });
  assert.equal(done.title, 'Called Dishoom (2 min)');
  assert.match(done.body, /Reference: under Patel\./);
  for (const endedBy of ['no_answer', 'busy', 'hung_up']) {
    const none = describeOutcome({ businessName: 'Dishoom', outcome: null, endedBy });
    assert.match(none.body, /Nothing was agreed\.$/);
    assert.equal(none.needsYou, false);
  }
});

test('Twilio webhook signatures are checked against the auth token', () => {
  const params = { CallSid: 'CA1', CallStatus: 'no-answer' };
  const url = 'https://adam.example/webhooks/calls/abc/status';
  const good = crypto.createHmac('sha1', 'tok').update(`${url}CallSidCA1CallStatusno-answer`).digest('base64');
  assert.equal(businessCalls.validTwilioSignature(url, params, good, 'tok'), true);
  assert.equal(businessCalls.validTwilioSignature(url, { ...params, CallStatus: 'completed' }, good, 'tok'), false);
  assert.equal(businessCalls.validTwilioSignature(url, params, good, 'other'), false);
  assert.equal(businessCalls.validTwilioSignature(url, params, undefined, 'tok'), false);
});

// --- bridge with fake sockets ----------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = false; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  feed(message) { this.emit('message', JSON.stringify(message)); }
}

test('bridge: setup, disclosure first, audio both ways, barge-in, and the time limit', () => {
  const twilio = new FakeSocket();
  const realtime = new FakeSocket();
  const timers = [];
  let hungUp = null;
  let finished = null;
  bridgeCall({
    twilio, realtime, brief: 'BRIEF', disclosure: 'Hello, this is Adam.', maxSeconds: 30,
    onHangup: reason => { hungUp = reason; }, onFinished: result => { finished = result; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}
  });
  twilio.feed({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1' } });
  twilio.feed({ event: 'media', media: { payload: 'early' } });          // before the model is ready: held
  realtime.feed({ type: 'session.created' });
  const update = realtime.sent[0];
  assert.equal(update.type, 'session.update');
  assert.equal(update.session.instructions, 'BRIEF');
  assert.deepEqual(update.session.audio.input.format, { type: 'audio/pcmu' });
  assert.deepEqual(update.session.audio.output.format, { type: 'audio/pcmu' });
  assert.deepEqual(update.session.tools.map(t => t.name), ['report_outcome', 'end_call']);
  realtime.feed({ type: 'session.updated' });
  assert.deepEqual(realtime.sent[1], { type: 'input_audio_buffer.append', audio: 'early' });
  assert.equal(realtime.sent[2].type, 'response.create');
  assert.match(realtime.sent[2].response.instructions, /^Say exactly: "Hello, this is Adam\."/);

  realtime.feed({ type: 'response.output_audio.delta', delta: 'AAAA' });
  assert.deepEqual(twilio.sent.at(-1), { event: 'media', media: { payload: 'AAAA' }, streamSid: 'MZ1' });
  realtime.feed({ type: 'input_audio_buffer.speech_started' });
  assert.deepEqual(twilio.sent.at(-1), { event: 'clear', streamSid: 'MZ1' });

  assert.equal(timers[0].ms, 30000);
  timers[0].fn();
  assert.equal(hungUp, 'time_limit');
  assert.equal(finished.endedBy, 'time_limit');
  assert.equal(finished.outcome, null);
  assert.equal(realtime.closed && twilio.closed, true);
});

// --- the whole call over real sockets --------------------------------------------------------

function fakeRealtimeServer() {
  const wss = new WebSocket.Server({ port: 0 });
  const received = [];
  wss.on('connection', ws => {
    const send = m => ws.send(JSON.stringify(m));
    let responses = 0;
    send({ type: 'session.created' });
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      received.push(m);
      if (m.type === 'session.update') send({ type: 'session.updated' });
      if (m.type === 'input_audio_buffer.append' && m.audio === 'business-says-hello') {
        send({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Dishoom, how can I help?' });
        send({ type: 'response.output_audio_transcript.done', transcript: 'Could I book a table for four on Friday at half seven?' });
        send({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Friday is full, we have 9:15 with a ten pound deposit each.' });
        send({ type: 'response.function_call_arguments.done', name: 'report_outcome', call_id: 'c1',
          arguments: JSON.stringify({ status: 'needs_decision', summary: 'Friday at 7:30 is full.', offer: 'Friday 9:15pm with a £10 deposit per person' }) });
      }
      if (m.type === 'response.create') {
        responses += 1;
        if (responses === 1) send({ type: 'response.output_audio.delta', delta: 'disclosure-audio' });
        if (responses === 2) {
          send({ type: 'response.output_audio.delta', delta: 'goodbye-audio' });
          send({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'c2', arguments: '{}' });
          send({ type: 'response.done' });
        }
      }
    });
  });
  return { wss, received, url: () => `ws://127.0.0.1:${wss.address().port}` };
}

test('a whole call: placed, bridged, the business offers a different time, Adam hangs up and reports it', async () => {
  const realtime = fakeRealtimeServer();
  const placed = [];
  const hungUp = [];
  const saved = [];
  const raised = [];
  businessCalls.configure({
    saveMessage: async (...args) => saved.push(args),
    raise: async (...args) => raised.push(args),
    countCallsToday: async () => 0,
    openRealtime: () => new WebSocket(realtime.url()),
    twilio: { create: async params => { placed.push(params); return { callSid: 'CA42' }; }, hangUp: async sid => { hungUp.push(sid); } }
  });
  const server = http.createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket, head) => { if (!businessCalls.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const { id } = await businessCalls.startCall({
      userId: 'user-1', fromNumber: '+447700900000', baseUrl: 'https://adam.example', onBehalfOf: 'Sam',
      input: { phone: '020 7123 4567', business_name: 'Dishoom', goal: 'Book a table for 4 on Friday at 7:30pm', details: ['Booking name: Sam Patel'] }
    });
    const params = placed[0];
    assert.equal(params.To, '+442071234567');
    assert.equal(params.From, '+447700900000');
    assert.equal(params.TimeLimit, '390');
    assert.equal(params.StatusCallback, `https://adam.example/webhooks/calls/${id}/status`);
    const streamUrl = /<Stream url="([^"]+)"/.exec(params.Twiml)[1];
    assert.match(streamUrl, new RegExp(`^wss://adam\\.example/calls/media/${id}/[a-f0-9]{64}$`));

    // A stolen or guessed stream URL gets nothing.
    await assert.rejects(new Promise((resolve, reject) => {
      const bad = new WebSocket(`ws://127.0.0.1:${server.address().port}/calls/media/${id}/${'0'.repeat(64)}`);
      bad.on('open', resolve); bad.on('error', reject);
    }));

    const phone = new WebSocket(streamUrl.replace('wss://adam.example', `ws://127.0.0.1:${server.address().port}`));
    const toPhone = [];
    phone.on('message', raw => {
      const m = JSON.parse(raw);
      toPhone.push(m);
      if (m.event === 'mark' && m.mark.name === END_MARK) phone.send(JSON.stringify({ event: 'mark', streamSid: 'MZ9', mark: { name: END_MARK } }));
    });
    await new Promise(resolve => phone.on('open', resolve));
    phone.send(JSON.stringify({ event: 'connected' }));
    phone.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ9', callSid: 'CA42' } }));
    await new Promise(resolve => setTimeout(resolve, 150));
    phone.send(JSON.stringify({ event: 'media', media: { payload: 'business-says-hello' } }));

    for (let i = 0; i < 100 && !saved.length; i++) await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(toPhone.filter(m => m.event === 'media').map(m => m.media.payload), ['disclosure-audio', 'goodbye-audio']);
    assert.deepEqual(hungUp, ['CA42']);
    const firstResponse = realtime.received.find(m => m.type === 'response.create');
    assert.match(firstResponse.response.instructions, /Hello, this is Adam, an AI assistant calling on behalf of Sam\./);
    assert.match(realtime.received.find(m => m.type === 'session.update').session.instructions, /- Booking name: Sam Patel/);

    const [userId, role, content] = saved[0];
    assert.equal(userId, 'user-1');
    assert.equal(role, 'assistant');
    assert.equal(content.text, 'Dishoom needs your answer. Friday at 7:30 is full. They offered: Friday 9:15pm with a £10 deposit per person. Nothing is confirmed until you say so.');
    assert.match(content.call.transcript, /Them: Friday is full/);
    assert.equal(raised[0][1].category, 'action_required');
    assert.equal(businessCalls._calls.has(id), false);
    phone.close();
  } finally {
    server.close();
    realtime.wss.close();
  }
});

test('a call nobody answers is reported as such; the daily cap and missing setup are refused', async () => {
  const saved = [];
  businessCalls.configure({
    saveMessage: async (...args) => saved.push(args), raise: async () => {}, countCallsToday: async () => 0,
    twilio: { create: async () => ({ callSid: 'CA7' }), hangUp: async () => {} }
  });
  const input = { phone: '+442071234567', business_name: 'Dishoom', goal: 'Ask if they have a table tonight' };
  const { id } = await businessCalls.startCall({ userId: 'u', fromNumber: '+447700900000', baseUrl: 'https://adam.example', input });
  await businessCalls.handleStatus(id, { CallStatus: 'no-answer' });
  assert.equal(saved[0][2].text, 'Call to Dishoom. No one answered. Nothing was agreed.');

  businessCalls.configure({ saveMessage: async () => {}, raise: async () => {}, countCallsToday: async () => 5, twilio: { create: async () => ({}) } });
  await assert.rejects(businessCalls.startCall({ userId: 'u', fromNumber: '+447700900000', baseUrl: 'https://adam.example', input }), { code: 'cap' });
  await assert.rejects(businessCalls.startCall({ userId: 'u', fromNumber: null, baseUrl: 'https://adam.example', input }), { code: 'no_number' });
  await assert.rejects(businessCalls.startCall({ userId: 'u', fromNumber: '+447700900000', baseUrl: '', input }), { code: 'not_configured' });
});

// --- callbacks to the shared number ----------------------------------------------------------

test('a business calling back is put through to the person Adam called for, without revealing their number', async () => {
  process.env.TWILIO_PHONE_NUMBER = '+447700900000';
  const raised = [];
  const lookups = [];
  businessCalls.configure({
    saveMessage: async () => {}, raise: async (...args) => raised.push(args), countCallsToday: async () => 0,
    findCallback: async caller => {
      lookups.push(caller);
      return { '+442071234567': { userId: 'u1', businessName: 'Dishoom', userPhone: '07700 900123' },
        '+442079999999': { userId: 'u2', businessName: 'Barbers', userPhone: null },
        '+442070000000': { ambiguous: true } }[caller] || null;
    }
  });

  const through = await businessCalls.handleInboundCall({ from: '+442071234567' });
  assert.match(through, /<Dial timeout="25" callerId="\+447700900000"><Number>\+447700900123<\/Number><\/Dial>/);
  assert.equal(raised[0][0], 'u1');
  assert.equal(raised[0][1].title, 'Dishoom is calling back');
  assert.match(raised[0][1].body, /Putting them through to you now from \+447700900000/);

  const noPhone = await businessCalls.handleInboundCall({ from: '020 7999 9999' });
  assert.doesNotMatch(noPhone, /<Dial/);
  assert.match(raised[1][1].body, /Call them back on \+442079999999\. Add your phone number in Settings/);

  raised.length = 0;
  for (const from of ['+442070000000', '+442075555555', 'anonymous', '']) {
    const twiml = await businessCalls.handleInboundCall({ from });
    assert.doesNotMatch(twiml, /<Dial/);
    assert.match(twiml, /cannot take calls/);
  }
  assert.equal(raised.length, 0, 'an unknown or ambiguous caller tells nobody anything');
  assert.deepEqual(lookups, ['+442071234567', '+442079999999', '+442070000000', '+442075555555']);
});

test('calls go out from the shared number, the brief points callbacks at it, and the log can find who it was for', async () => {
  process.env.TWILIO_PHONE_NUMBER = '+447700900000';
  const placed = [];
  businessCalls.configure({ saveMessage: async () => {}, raise: async () => {}, countCallsToday: async () => 0,
    twilio: { create: async params => { placed.push(params); return { callSid: 'CA1' }; } } });
  const { handlers } = require('../../api/actions/calls');
  const previous = process.env.APP_URL;
  process.env.APP_URL = 'https://adam.example';
  try {
    const result = await handlers.call_business({
      userId: 'u1',
      params: { phone: '020 7123 4567', business_name: 'Dishoom', goal: 'Ask about a table tonight' },
      deps: { getPreferenceMap: async () => ({ 'checkout_profile.name': '"Sam Patel"' }) }
    });
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.text, 'Calling Dishoom (+442071234567) now. I\'ll tell you what they say.');
    assert.equal(placed[0].From, '+447700900000');
    const call = [...businessCalls._calls.values()].find(c => c.request.phone === '+442071234567');
    assert.match(call.brief, /ask them to ring the number you are calling from; it reaches Sam\. Never give out any other number\./);
    assert.equal(call.disclosure, 'Hello, this is Adam, an AI assistant calling on behalf of Sam.');
  } finally {
    if (previous === undefined) delete process.env.APP_URL; else process.env.APP_URL = previous;
  }
});

// --- ElevenLabs engine -----------------------------------------------------------------------

const elevenlabsEngine = require('../../api/services/call-engine-elevenlabs');
const { outcomeExtractionPrompt } = require('../../api/services/business-call');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const path = new URL(url).pathname;
    const key = `${init.method || 'GET'} ${path}`;
    const handler = routes[key] || routes[`${init.method || 'GET'} ${path.replace(/\/[^/]+$/, '/:id')}`];
    if (!handler) return new Response('not found', { status: 404 });
    const { status = 200, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status });
  };
  return { impl, calls };
}

function useElevenLabsEnv() {
  process.env.ELEVENLABS_API_KEY = 'xi-test';
  process.env.ELEVENLABS_AGENT_ID = 'agent_1';
  process.env.ELEVENLABS_PHONE_NUMBER_ID = 'phnum_1';
}

test('ElevenLabs places the call itself, with the brief, the fixed opening line and the time limit', async () => {
  useElevenLabsEnv();
  const { impl, calls } = fakeFetch({ 'POST /v1/convai/twilio/outbound-call': () => ({ body: { success: true, message: 'ok', conversation_id: 'conv_1', callSid: 'CA1' } }) });
  const placed = await elevenlabsEngine.placeCall({ to: '+442071234567', brief: 'BRIEF', firstMessage: 'Hello, this is Adam.', maxSeconds: 360, callId: 'c1', fetchImpl: impl });
  assert.deepEqual(placed, { conversationId: 'conv_1', callSid: 'CA1' });
  assert.equal(calls[0].init.headers['xi-api-key'], 'xi-test');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    agent_id: 'agent_1', agent_phone_number_id: 'phnum_1', to_number: '+442071234567',
    conversation_initiation_client_data: {
      conversation_config_override: { agent: { prompt: { prompt: 'BRIEF' }, first_message: 'Hello, this is Adam.' }, conversation: { max_duration_seconds: 360 } },
      dynamic_variables: { forward_to: '', adam_call_id: 'c1' }
    }
  });
  const refused = fakeFetch({ 'POST /v1/convai/twilio/outbound-call': () => ({ body: { success: false, message: 'Number not verified', conversation_id: null, callSid: null } }) });
  await assert.rejects(elevenlabsEngine.placeCall({ to: '+44', fetchImpl: refused.impl }), /Number not verified/);
  const error = fakeFetch({ 'POST /v1/convai/twilio/outbound-call': () => ({ status: 422, body: { detail: 'bad' } }) });
  await assert.rejects(elevenlabsEngine.placeCall({ to: '+44', fetchImpl: error.impl }), /returned 422/);
});

test('a conversation is read once ElevenLabs has finished writing it', async () => {
  useElevenLabsEnv();
  let status = 'processing';
  const { impl } = fakeFetch({ 'GET /v1/convai/conversations/:id': () => ({ body: { conversation_id: 'conv_1', status,
    metadata: { call_duration_secs: 74, termination_reason: 'end_call tool' },
    transcript: [{ role: 'agent', message: 'Hello, this is Adam.' }, { role: 'user', message: 'Friday is full, 9:15 works.' }, { role: 'agent', message: null }] } }) });
  assert.deepEqual(await elevenlabsEngine.getConversation({ conversationId: 'conv_1', fetchImpl: impl }), { pending: true });
  status = 'done';
  const found = await elevenlabsEngine.getConversation({ conversationId: 'conv_1', fetchImpl: impl });
  assert.equal(found.seconds, 74);
  assert.equal(found.failed, false);
  assert.deepEqual(found.transcript, [{ speaker: 'adam', text: 'Hello, this is Adam.' }, { speaker: 'them', text: 'Friday is full, 9:15 works.' }]);
});

test('the agent: phone audio, hang-up/voicemail/transfer tools, the callback webhook, and narrow overrides', () => {
  const agent = elevenlabsEngine.agentDefinition({ voiceId: 'voice_1', webhookUrl: 'https://adam.example/webhooks/calls/elevenlabs-inbound', webhookSecret: 's3cret' });
  const cfg = agent.conversation_config;
  assert.equal(cfg.asr.user_input_audio_format, 'ulaw_8000');
  assert.equal(cfg.tts.agent_output_audio_format, 'ulaw_8000');
  assert.deepEqual(Object.keys(cfg.agent.prompt.built_in_tools), ['end_call', 'voicemail_detection', 'transfer_to_number']);
  assert.equal(cfg.agent.prompt.built_in_tools.voicemail_detection.params.voicemail_message, undefined, 'nothing is left on voicemail');
  const transfer = cfg.agent.prompt.built_in_tools.transfer_to_number.params.transfers[0];
  assert.deepEqual(transfer.transfer_destination, { type: 'phone_dynamic_variable', phone_number: '{{forward_to}}' });
  assert.match(transfer.condition, /Never on calls Adam placed/);
  assert.equal(agent.platform_settings.overrides.enable_conversation_initiation_client_data_from_webhook, true);
  assert.deepEqual(agent.platform_settings.overrides.conversation_config_override, { agent: { first_message: true, prompt: { prompt: true } }, conversation: { max_duration_seconds: true } });
  assert.deepEqual(agent.platform_settings.workspace_overrides.conversation_initiation_client_data_webhook,
    { url: 'https://adam.example/webhooks/calls/elevenlabs-inbound', request_headers: { 'x-adam-webhook-secret': 's3cret' } });
});

test('setup imports the Twilio number into ElevenLabs and links it to the agent', async () => {
  useElevenLabsEnv();
  const { impl, calls } = fakeFetch({
    'POST /v1/convai/phone-numbers': () => ({ body: { phone_number_id: 'phnum_9' } }),
    'PATCH /v1/convai/phone-numbers/:id': () => ({ body: {} })
  });
  assert.equal(await elevenlabsEngine.importTwilioNumber({ phoneNumber: '+447700900000', sid: 'AC1', token: 'tok', agentId: 'agent_1', fetchImpl: impl }), 'phnum_9');
  assert.deepEqual(JSON.parse(calls[0].init.body), { provider: 'twilio', phone_number: '+447700900000', label: 'Adam', sid: 'AC1', token: 'tok', supports_inbound: true, supports_outbound: true });
  assert.equal(calls[1].url, 'https://api.elevenlabs.io/v1/convai/phone-numbers/phnum_9');
  assert.deepEqual(JSON.parse(calls[1].init.body), { agent_id: 'agent_1' });
});

test('outcome extraction asks only for what was said, and treats any offer or payment as needing a decision', () => {
  const prompt = outcomeExtractionPrompt({ businessName: 'Dishoom', goal: 'Book Friday 7:30 for 4', fallback: 'Saturday' },
    [{ speaker: 'adam', text: 'Hello' }, { speaker: 'them', text: 'Full Friday' }]);
  assert.match(prompt, /phoned Dishoom to: Book Friday 7:30 for 4/);
  assert.match(prompt, /Adam: Hello\nBusiness: Full Friday/);
  assert.match(prompt, /Use "done" only if the business clearly confirmed exactly what was asked/);
  assert.match(prompt, /deposit, payment or the person's agreement, use "needs_decision"/);
});

function elevenLabsRuntime(overrides = {}) {
  const saved = [];
  const raised = [];
  const engine = { ...elevenlabsEngine, placeCall: async () => ({ conversationId: 'conv_1', callSid: 'CA1' }), getConversation: async () => ({ pending: true }), ...overrides.engine };
  businessCalls.configure({
    engine: 'elevenlabs', sleep: async () => {}, countCallsToday: async () => 0,
    saveMessage: async (...args) => saved.push(args), raise: async (...args) => raised.push(args),
    elevenlabs: engine, ...overrides.runtime
  });
  return { saved, raised };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const dishoom = { phone: '020 7123 4567', business_name: 'Dishoom', goal: 'Book a table for 4 on Friday at 7:30pm' };

test('a whole ElevenLabs call: placed with no Twilio settings in Adam, followed by id, result read from the transcript', async () => {
  delete process.env.TWILIO_PHONE_NUMBER;
  const placed = [];
  let reads = 0;
  const { saved } = elevenLabsRuntime({
    engine: {
      placeCall: async args => { placed.push(args); return { conversationId: 'conv_7', callSid: 'CA7' }; },
      getConversation: async ({ conversationId }) => {
        assert.equal(conversationId, 'conv_7');
        reads += 1;
        return reads < 3 ? { pending: true } : { seconds: 80, transcript: [{ speaker: 'adam', text: 'Hello, this is Adam.' }, { speaker: 'them', text: 'Booked, under Patel.' }] };
      }
    },
    runtime: { extractOutcome: async () => '{"status":"done","summary":"Booked for 4 at 7:30 Friday.","reference":"under Patel"}' }
  });
  await businessCalls.startCall({ userId: 'u1', fromNumber: null, baseUrl: '', onBehalfOf: 'Sam', input: dishoom });
  assert.equal(placed[0].to, '+442071234567');
  assert.equal(placed[0].firstMessage, 'Hello, this is Adam, an AI assistant calling on behalf of Sam.');
  assert.equal(placed[0].maxSeconds, 360);
  assert.match(placed[0].brief, /Never give or agree to card numbers/);
  for (let i = 0; i < 20 && !saved.length; i++) await settle();
  assert.equal(reads, 3);
  assert.equal(saved[0][2].text, 'Called Dishoom (1 min). Booked for 4 at 7:30 Friday. Reference: under Patel.');
  assert.match(saved[0][2].call.transcript, /Them: Booked, under Patel\./);
});

test('ElevenLabs: unanswered, failed, or unreadable calls are never reported as success', async () => {
  const cases = [
    [{ seconds: 0, transcript: [{ speaker: 'adam', text: 'Hello, this is Adam.' }] }, null, 'Call to Dishoom. No one answered. Nothing was agreed.'],
    [{ failed: true, seconds: 0, transcript: [] }, null, 'Call to Dishoom. The call could not be placed. Nothing was agreed.'],
    [{ seconds: 20, transcript: [{ speaker: 'them', text: 'Hello?' }] }, 'not json', /Nothing was agreed\.$/]
  ];
  for (const [conversation, extracted, expected] of cases) {
    const { saved } = elevenLabsRuntime({ engine: { getConversation: async () => conversation }, runtime: { extractOutcome: async () => extracted } });
    await businessCalls.startCall({ userId: 'u', input: dishoom });
    for (let i = 0; i < 20 && !saved.length; i++) await settle();
    if (expected instanceof RegExp) assert.match(saved[0][2].text, expected); else assert.equal(saved[0][2].text, expected);
  }
  const { saved } = elevenLabsRuntime({ engine: { placeCall: async () => { throw new Error('Number not verified'); } } });
  await assert.rejects(businessCalls.startCall({ userId: 'u', input: dishoom }), /couldn't place the call: Number not verified/);
  assert.equal(saved.length, 0);
});

test('a callback is matched to its person: offered a transfer to their phone, told at once, and sent the message after', async () => {
  const { raised, saved } = elevenLabsRuntime({
    engine: { getConversation: async () => ({ seconds: 40, transcript: [{ speaker: 'them', text: 'We can do Friday at 7:30 after all.' }] }) },
    runtime: {
      findCallback: async caller => (caller === '+442071234567' ? { userId: 'u1', businessName: 'Dishoom', goal: 'Book a table for 4 on Friday', userPhone: '07700 900123', userName: 'Sam' } : null),
      extractOutcome: async () => '{"status":"needs_decision","summary":"They can do Friday at 7:30 after all.","offer":"Friday 7:30pm"}'
    }
  });
  const data = await businessCalls.handleElevenLabsInbound({ caller_id: '+442071234567', conversation_id: 'conv_cb' });
  assert.equal(data.dynamic_variables.forward_to, '+447700900123');
  assert.match(data.conversation_config_override.agent.prompt.prompt, /answering a call from Dishoom\. Adam called them recently for Sam about: Book a table for 4 on Friday/);
  assert.match(data.conversation_config_override.agent.prompt.prompt, /use transfer_to_number/);
  assert.equal(data.conversation_config_override.agent.first_message, 'Hello, this is Adam, an AI assistant for Sam. Thanks for calling back.');
  assert.equal(raised[0][1].title, 'Dishoom is calling back');
  for (let i = 0; i < 20 && !saved.length; i++) await settle();
  assert.equal(saved[0][2].text, 'Dishoom called back. They can do Friday at 7:30 after all. They offered: Friday 7:30pm. Nothing is confirmed until you say so.');
});

test('a callback with no saved phone takes a message; an unknown or shared caller learns nothing and nobody is told', async () => {
  const { raised } = elevenLabsRuntime({ runtime: { findCallback: async caller => ({
    '+442071234567': { userId: 'u1', businessName: 'Dishoom', userPhone: null },
    '+442070000000': { ambiguous: true } }[caller] || null) } });
  const noPhone = await businessCalls.handleElevenLabsInbound({ caller_id: '+442071234567' });
  assert.equal(noPhone.dynamic_variables.forward_to, '');
  assert.match(noPhone.conversation_config_override.agent.prompt.prompt, /cannot be put through right now\. Take a message\./);
  assert.match(raised[0][1].body, /their number is \+442071234567/);
  raised.length = 0;
  for (const caller of ['+442070000000', '+442075555555', 'anonymous', undefined]) {
    const data = await businessCalls.handleElevenLabsInbound({ caller_id: caller });
    assert.equal(data.dynamic_variables.forward_to, '');
    assert.equal(data.conversation_config_override.agent.prompt.prompt, elevenlabsEngine.INBOUND_FALLBACK_PROMPT);
  }
  assert.equal(raised.length, 0);
});

test('the callback webhook only answers ElevenLabs (shared secret header)', () => {
  process.env.ELEVENLABS_WEBHOOK_SECRET = 'hook-secret';
  assert.equal(businessCalls.validWebhookSecret('hook-secret'), true);
  assert.equal(businessCalls.validWebhookSecret('hook-secreT'), false);
  assert.equal(businessCalls.validWebhookSecret(undefined), false);
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  assert.equal(businessCalls.validWebhookSecret('anything'), false, 'no secret configured means nothing is accepted');
});
