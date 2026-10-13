'use strict';

// Connects a live phone call (Twilio Media Streams: 8 kHz μ-law frames over a WebSocket) to a
// realtime speech model (OpenAI Realtime, which speaks μ-law natively, so audio passes through
// untouched). The model gets the call brief and two tools; everything else here is plumbing that
// the model can't influence: the opening disclosure, barge-in, the time limit and hanging up.

const { CALL_TOOLS, MAX_CALL_SECONDS, normalizeOutcome } = require('./business-call');

const END_MARK = 'adam-end';
const HANGUP_GRACE_MS = 8000;

function parse(data) {
  try { return JSON.parse(typeof data === 'string' ? data : data.toString('utf8')); } catch { return null; }
}

function sessionUpdate({ instructions, voice, transcriptionModel }) {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions,
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          turn_detection: { type: 'server_vad' },
          transcription: { model: transcriptionModel }
        },
        output: { format: { type: 'audio/pcmu' }, voice }
      },
      tools: CALL_TOOLS,
      tool_choice: 'auto'
    }
  };
}

// twilio, realtime: WebSocket-like ({ send, close, on('message'|'close'|'error') }).
// onHangup(): end the phone call. onFinished(result): called once, with the reported outcome (or
// null), the transcript and why the call ended.
function bridgeCall({ twilio, realtime, brief, disclosure, voice = 'marin', transcriptionModel = 'gpt-4o-mini-transcribe',
  maxSeconds = MAX_CALL_SECONDS, onHangup = () => {}, onFinished = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let streamSid = null;
  let callSid = null;
  let started = null;
  let outcome = null;
  let endRequested = false;
  let finished = false;
  let greeted = false;
  let sessionReady = false;
  const pendingAudio = [];
  const transcript = [];
  const timers = [];

  const toModel = message => { try { realtime.send(JSON.stringify(message)); } catch { /* closing */ } };
  const toCall = message => { if (streamSid) try { twilio.send(JSON.stringify({ ...message, streamSid })); } catch { /* closing */ } };
  const later = (fn, ms) => { const t = setTimer(fn, ms); timers.push(t); return t; };

  function hangUp(reason) {
    if (finished) return;
    try { onHangup(reason); } catch { /* reported in finish */ }
    finish(reason);
  }

  function finish(endedBy) {
    if (finished) return;
    finished = true;
    for (const t of timers) clearTimer(t);
    try { realtime.close(); } catch { /* already closed */ }
    try { twilio.close(); } catch { /* already closed */ }
    onFinished({
      callSid,
      outcome,
      endedBy: outcome ? 'completed' : endedBy,
      seconds: started ? Math.round((now() - started) / 1000) : 0,
      transcript
    });
  }

  function greet() {
    if (greeted || !sessionReady || !streamSid) return;
    greeted = true;
    // The disclosure is fixed text: the model is told to say exactly this before anything else.
    toModel({ type: 'response.create', response: { instructions: `Say exactly: "${disclosure}" Then, in one sentence, say why you are calling.` } });
  }

  twilio.on('message', data => {
    const event = parse(data);
    if (!event) return;
    if (event.event === 'start') {
      streamSid = event.start?.streamSid || event.streamSid || null;
      callSid = event.start?.callSid || null;
      started = now();
      later(() => hangUp('time_limit'), maxSeconds * 1000);
      greet();
    } else if (event.event === 'media' && event.media?.payload) {
      if (sessionReady) toModel({ type: 'input_audio_buffer.append', audio: event.media.payload });
      else if (pendingAudio.length < 250) pendingAudio.push(event.media.payload);
    } else if (event.event === 'mark' && event.mark?.name === END_MARK) {
      hangUp('completed');
    } else if (event.event === 'stop') {
      finish('hung_up');
    }
  });
  twilio.on('close', () => finish('hung_up'));
  twilio.on('error', () => finish('call_error'));

  realtime.on('message', data => {
    const event = parse(data);
    if (!event) return;
    switch (event.type) {
      case 'session.created':
        toModel(sessionUpdate({ instructions: brief, voice, transcriptionModel }));
        break;
      case 'session.updated':
        if (!sessionReady) {
          sessionReady = true;
          for (const audio of pendingAudio.splice(0)) toModel({ type: 'input_audio_buffer.append', audio });
          greet();
        }
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (event.delta) toCall({ event: 'media', media: { payload: event.delta } });
        break;
      case 'input_audio_buffer.speech_started':
        // They started talking: stop playing whatever Adam was saying.
        toCall({ event: 'clear' });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) transcript.push({ speaker: 'them', text: String(event.transcript).trim() });
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (event.transcript) transcript.push({ speaker: 'adam', text: String(event.transcript).trim() });
        break;
      case 'response.function_call_arguments.done': {
        if (event.name === 'report_outcome') {
          if (!outcome) outcome = normalizeOutcome(event.arguments);
          toModel({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify({ recorded: Boolean(outcome) }) } });
          toModel({ type: 'response.create' });
        } else if (event.name === 'end_call') {
          endRequested = true;
          toModel({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: '{"ok":true}' } });
        }
        break;
      }
      case 'response.done':
        if (endRequested) {
          // Hang up once Twilio has played everything already sent; give up waiting after a grace period.
          toCall({ event: 'mark', mark: { name: END_MARK } });
          later(() => hangUp('completed'), HANGUP_GRACE_MS);
          endRequested = false;
        }
        break;
      case 'error':
        if (!sessionReady) hangUp('model_error');
        break;
      default:
        break;
    }
  });
  realtime.on('close', () => { if (!finished) hangUp('model_closed'); });
  realtime.on('error', () => { if (!finished) hangUp('model_error'); });

  return { get outcome() { return outcome; }, get transcript() { return transcript; }, hangUp };
}

module.exports = { END_MARK, bridgeCall, sessionUpdate };
