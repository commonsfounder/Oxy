// Phase 1: native function calling on the plain-chat path.
//
// Before this, /chat and /process-audio sent `useAgentTools: false`, openAIRequestFromConfig
// dropped tool declarations, and streamChatCompletionSSE never read delta.tool_calls — so the
// classic path had no working action mechanism and answered "I can't set reminders directly
// here" for tools the user has connected. These tests pin each link of that chain.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  openAIRequestFromConfig,
  streamChatCompletionSSE,
  geminiToolsToOpenAI
} = require('../../api/services/brain-provider');
const { buildToolsForGemini, ACTION_CONTRACTS } = require('../../api/action-contracts');
const { mergeNativeToolCalls, buildModernGenerateRequest } = require('../../api/index');

// Builds a Response-like object whose body streams the given SSE frames, so the real
// streamChatCompletionSSE runs unmodified against synthetic provider output.
function sseResponse(frames) {
  const encoder = new TextEncoder();
  const payload = frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('');
  let sent = false;
  return {
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: encoder.encode(payload) }))
      })
    }
  };
}

// Same, but delivers the payload one arbitrary slice at a time — frames split mid-JSON.
function chunkedSseResponse(frames, sliceSize) {
  const encoder = new TextEncoder();
  const payload = frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('');
  let offset = 0;
  return {
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= payload.length) return { done: true };
          const slice = payload.slice(offset, offset + sliceSize);
          offset += sliceSize;
          return { done: false, value: encoder.encode(slice) };
        }
      })
    }
  };
}

const contentFrame = (text) => ({ choices: [{ delta: { content: text } }] });
const toolFrame = (index, { id, name, args } = {}) => ({
  choices: [{ delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), ...(args !== undefined ? { arguments: args } : {}) } }] } }]
});

async function drain(res) {
  const chunks = [];
  for await (const chunk of streamChatCompletionSSE(res)) chunks.push(chunk);
  return chunks;
}

// ── 9. Provider rejection if tools ride with an unsupported reasoning effort ───────────────
// Verified live 2026-08-06: gpt-5.6-luna 400s on tools + effort 'low' AND on tools + effort
// omitted. 'none' must be set explicitly, which is what this asserts.
test('openAIRequestFromConfig forces reasoning_effort none whenever tools are attached', () => {
  const saved = process.env.OXY_CHAT_REASONING_EFFORT;
  process.env.OXY_CHAT_REASONING_EFFORT = 'high';

  const withTools = openAIRequestFromConfig({ tools: buildToolsForGemini(false) });
  assert.equal(withTools.reasoning_effort, 'none', 'tools + any other effort is a hard 400');
  assert.equal(withTools.tool_choice, 'auto');
  assert.ok(withTools.tools.length > 0);
  assert.ok(withTools.tools.every((t) => t.type === 'function' && t.function?.name));

  if (saved === undefined) delete process.env.OXY_CHAT_REASONING_EFFORT;
  else process.env.OXY_CHAT_REASONING_EFFORT = saved;
});

// ── 1. Ordinary conversation — no tools requested means no tool fields on the wire ────────
test('openAIRequestFromConfig omits tool fields entirely when no tools are configured', () => {
  for (const config of [{}, { tools: [] }, { tools: [{ functionDeclarations: [] }] }]) {
    const body = openAIRequestFromConfig(config);
    assert.equal('tools' in body, false, JSON.stringify(config));
    assert.equal('tool_choice' in body, false);
    assert.notEqual(body.reasoning_effort, 'none', 'tool-free turns keep their configured effort');
  }
});

test('buildModernGenerateRequest attaches the full declaration set when tools are enabled', () => {
  const withTools = buildModernGenerateRequest({
    dynamicSystemPrompt: 'x', useSearch: false, cachedContentName: '',
    baseHistory: [], userContent: { role: 'user', parts: [{ text: 'hi' }] }, useAgentTools: true
  });
  const decls = withTools.config.tools.find((t) => t.functionDeclarations)?.functionDeclarations || [];
  assert.equal(decls.length, Object.keys(ACTION_CONTRACTS).length);

  const without = buildModernGenerateRequest({
    dynamicSystemPrompt: 'x', useSearch: false, cachedContentName: '',
    baseHistory: [], userContent: { role: 'user', parts: [{ text: 'hi' }] }, useAgentTools: false
  });
  assert.equal(without.config.tools, undefined);
});

// ── 1. Ordinary conversation — text only, and no phantom tool-call chunk ──────────────────
test('streamChatCompletionSSE yields text only when the model calls no tool', async () => {
  const chunks = await drain(sseResponse([contentFrame('Hey'), contentFrame(' there'), '[DONE]']));
  assert.deepEqual(chunks.map((c) => c.text), ['Hey', ' there']);
  assert.equal(chunks.some((c) => c.functionCalls), false, 'no tool call must mean no functionCalls chunk');
});

// ── 2. One direct tool call ───────────────────────────────────────────────────────────────
test('streamChatCompletionSSE emits a single complete tool call', async () => {
  const chunks = await drain(sseResponse([
    toolFrame(0, { id: 'call_a', name: 'create_reminder', args: '{"text":"call dentist","time":"tomorrow 10am"}' }),
    '[DONE]'
  ]));
  const calls = chunks.at(-1).functionCalls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create_reminder');
  assert.equal(calls[0].id, 'call_a');
  assert.deepEqual(calls[0].args, { text: 'call dentist', time: 'tomorrow 10am' });
  // The Gemini-shaped mirror the agent loop's extractToolCalls reads.
  assert.equal(chunks.at(-1).candidates[0].content.parts[0].functionCall.name, 'create_reminder');
});

// ── 3. Arguments (and name) split across streaming chunks ─────────────────────────────────
test('streamChatCompletionSSE reassembles a tool call fragmented across frames', async () => {
  const chunks = await drain(sseResponse([
    toolFrame(0, { id: 'call_b', name: 'find_pl' }),
    toolFrame(0, { name: 'ace' }),
    toolFrame(0, { args: '{"qu' }),
    toolFrame(0, { args: 'ery":"gym n' }),
    toolFrame(0, { args: 'ear me"}' }),
    '[DONE]'
  ]));
  const calls = chunks.at(-1).functionCalls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'find_place');
  assert.deepEqual(calls[0].args, { query: 'gym near me' });
});

test('streamChatCompletionSSE reassembles when SSE frames are split mid-JSON by the socket', async () => {
  const frames = [
    contentFrame('one moment'),
    toolFrame(0, { id: 'call_c', name: 'play_music', args: '{"query":"Steve Lacy"}' }),
    '[DONE]'
  ];
  for (const sliceSize of [1, 7, 23, 500]) {
    const chunks = await drain(chunkedSseResponse(frames, sliceSize));
    const calls = chunks.at(-1).functionCalls;
    assert.equal(calls.length, 1, `sliceSize=${sliceSize}`);
    assert.deepEqual(calls[0].args, { query: 'Steve Lacy' }, `sliceSize=${sliceSize}`);
    assert.equal(chunks.filter((c) => c.text).map((c) => c.text).join(''), 'one moment');
  }
});

test('streamChatCompletionSSE still emits tool calls when the stream ends without [DONE]', async () => {
  const chunks = await drain(sseResponse([toolFrame(0, { id: 'x', name: 'get_weather', args: '{}' })]));
  assert.equal(chunks.at(-1).functionCalls[0].name, 'get_weather');
});

test('streamChatCompletionSSE degrades unparseable arguments to {} rather than dropping the call', async () => {
  const chunks = await drain(sseResponse([toolFrame(0, { id: 'x', name: 'find_place', args: '{"query":' }), '[DONE]']));
  const calls = chunks.at(-1).functionCalls;
  assert.equal(calls.length, 1, 'the call survives so the action runner can reject it on required params');
  assert.deepEqual(calls[0].args, {});
});

// ── 4. Spoken text AND a tool call in the same response ───────────────────────────────────
test('streamChatCompletionSSE preserves interleaved text alongside a tool call', async () => {
  const chunks = await drain(sseResponse([
    contentFrame('Sure — '),
    toolFrame(0, { id: 'call_d', name: 'create_reminder', args: '{"text":' }),
    contentFrame('setting that now.'),
    toolFrame(0, { args: '"call dentist"}' }),
    '[DONE]'
  ]));
  assert.equal(chunks.filter((c) => c.text).map((c) => c.text).join(''), 'Sure — setting that now.');
  const calls = chunks.at(-1).functionCalls;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { text: 'call dentist' });
});

// ── 5. Multiple tool calls in one turn ────────────────────────────────────────────────────
test('streamChatCompletionSSE keeps parallel tool calls separate and ordered by index', async () => {
  const chunks = await drain(sseResponse([
    toolFrame(0, { id: 'c0', name: 'find_place', args: '{"query":' }),
    toolFrame(1, { id: 'c1', name: 'get_weather', args: '{"location":' }),
    toolFrame(0, { args: '"gym"}' }),
    toolFrame(1, { args: '"Birmingham"}' }),
    '[DONE]'
  ]));
  const calls = chunks.at(-1).functionCalls;
  assert.deepEqual(calls.map((c) => c.name), ['find_place', 'get_weather']);
  assert.deepEqual(calls[0].args, { query: 'gym' });
  assert.deepEqual(calls[1].args, { location: 'Birmingham' });
  assert.deepEqual(calls.map((c) => c.id), ['c0', 'c1']);
});

test('streamChatCompletionSSE synthesises an id when the provider omits one', async () => {
  const chunks = await drain(sseResponse([toolFrame(0, { name: 'find_place', args: '{"query":"gym"}' }), '[DONE]']));
  assert.match(chunks.at(-1).functionCalls[0].id, /^call_find_place_/);
});

// ── Tool calls reach the action pipeline, in the shape executeActions consumes ─────────────
test('mergeNativeToolCalls converts calls to internal actions and leads the text-parsed list', () => {
  const merged = mergeNativeToolCalls(
    [{ id: 'c0', name: 'create_reminder', args: { text: 'call dentist' } }],
    [{ type: 'legacy_text_action', input: {} }]
  );
  assert.deepEqual(merged, [
    { type: 'create_reminder', input: { text: 'call dentist' } },
    { type: 'legacy_text_action', input: {} }
  ]);
});

test('mergeNativeToolCalls is a no-op when the model called nothing', () => {
  const textActions = [{ type: 'a', input: {} }];
  assert.equal(mergeNativeToolCalls([], textActions), textActions);
  assert.equal(mergeNativeToolCalls(undefined, textActions), textActions);
  assert.deepEqual(mergeNativeToolCalls([], []), []);
});

test('mergeNativeToolCalls defaults missing arguments to an empty input object', () => {
  assert.deepEqual(mergeNativeToolCalls([{ name: 'get_weather' }], []), [{ type: 'get_weather', input: {} }]);
});

// ── 6. Review-required actions still gate, from the native path too ───────────────────────
// executionMode is read off the contract by action-runner, never from what the model was
// told, so review gating cannot regress when prompt text changes.
test('review-mode contracts survive the native path unchanged', () => {
  const reviewActions = Object.entries(ACTION_CONTRACTS)
    .filter(([, c]) => c.executionMode === 'review')
    .map(([type]) => type);
  assert.ok(reviewActions.length > 0);

  for (const type of reviewActions) {
    const [action] = mergeNativeToolCalls([{ name: type, args: { to: 'x' } }], []);
    assert.equal(action.type, type);
    assert.equal(
      ACTION_CONTRACTS[action.type].executionMode,
      'review',
      'an action arriving natively must still resolve to its review-mode contract'
    );
  }
});

test('every native declaration maps back to a real contract, so nothing executes unknown', () => {
  const decls = geminiToolsToOpenAI(buildToolsForGemini(false));
  for (const decl of decls) assert.ok(ACTION_CONTRACTS[decl.function.name], decl.function.name);
});

// ── 8. No claim of action when no tool call was emitted ───────────────────────────────────
test('a text-only turn produces zero actions — nothing can report as executed', async () => {
  const chunks = await drain(sseResponse([contentFrame('Playing Steve Lacy.'), '[DONE]']));
  const nativeCalls = chunks.flatMap((c) => c.functionCalls || []);
  assert.equal(nativeCalls.length, 0);
  assert.deepEqual(mergeNativeToolCalls(nativeCalls, []), [], 'no tool call must yield no action');
});

// ── 7. /process-audio (voice) and /chat both keep tools enabled ───────────────────────────
// Both routes build their request through buildModernGenerateRequest and merge through
// mergeNativeToolCalls, so the shared machinery is covered by the tests above. What a unit
// test cannot reach is the per-route flag itself — and that flag being flipped back to false
// is exactly how this bug shipped, silently, for a month. Guard it at the source.
test('neither plain-chat entry point disables native tools', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../api/index.js'), 'utf8');

  // The synthesis/compat routes that must STAY tool-free: two data follow-ups (chat streaming
  // + non-streaming), the voice follow-up, and both /chat-with-image calls.
  assert.equal(
    (src.match(/useAgentTools:\s*false/g) || []).length,
    5,
    'a route changed its tool posture — re-check which one and why'
  );
  assert.equal(
    (src.match(/useAgentTools:\s*true/g) || []).length,
    2,
    '/chat streaming and /process-audio must both request native tools'
  );

  // The voice route specifically: its initial request must be the tools-enabled one.
  const voiceRoute = src.slice(src.indexOf("app.post('/process-audio'"));
  const firstBuild = voiceRoute.indexOf('buildModernGenerateRequest(');
  const firstBuildBlock = voiceRoute.slice(firstBuild, firstBuild + 700);
  assert.match(firstBuildBlock, /useAgentTools:\s*true/, '/process-audio initial request lost its tools');
});

test('voice and chat share one merge path, so a tool call cannot be handled differently', () => {
  const call = [{ id: 'c0', name: 'create_reminder', args: { text: 'call dentist' } }];
  assert.deepEqual(mergeNativeToolCalls(call, []), [{ type: 'create_reminder', input: { text: 'call dentist' } }]);
});

// ── 10. The agentic path's conversion is untouched by this phase ───────────────────────────
test('geminiToolsToOpenAI still carries risk and guidance into the tool description', () => {
  const decls = geminiToolsToOpenAI(buildToolsForGemini(false));
  const sendMessage = decls.find((d) => d.function.name === 'send_message');
  assert.match(sendMessage.function.description, /Risk level: medium/);
  assert.equal(sendMessage.function.parameters.type, 'object');
  assert.ok(sendMessage.function.parameters.properties.contact);
  assert.deepEqual(sendMessage.function.parameters.required, ['contact', 'message']);
});
