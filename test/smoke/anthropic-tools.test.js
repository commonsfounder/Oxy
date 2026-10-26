const test = require('node:test');
const assert = require('node:assert');
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.OXY_USAGE_LOG = 'off';
const { generateBrain, streamBrain } = require('../../api/services/brain-provider');

const TOOLS = [{ functionDeclarations: [
  { name: 'web_search', description: 'search the web', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } },
  { name: 'calculate', description: 'maths', parameters: { type: 'OBJECT', properties: { expression: { type: 'STRING' } } } },
] }];
const CONTENTS = [{ role: 'user', parts: [{ text: 'tallest building in Manchester?' }] }];

test('Claude gets the tool list on the plain path and its tool call is read back', async (t) => {
  const saved = global.fetch;
  t.after(() => { global.fetch = saved; });
  let body;
  global.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { query: 'tallest building Manchester' } }], usage: { input_tokens: 10, output_tokens: 5 } }) };
  };
  const out = await generateBrain({ provider: 'anthropic', model: 'claude-haiku-5-5', contents: CONTENTS, config: { tools: TOOLS } });
  assert.deepStrictEqual(body.tools.map((x) => x.name), ['web_search', 'calculate']);
  assert.ok(body.tools[0].input_schema);
  assert.strictEqual(out.functionCalls[0].name, 'web_search');
  assert.deepStrictEqual(out.functionCalls[0].args, { query: 'tallest building Manchester' });
});

test('a call with no tools sends none', async (t) => {
  const saved = global.fetch;
  t.after(() => { global.fetch = saved; });
  let body;
  global.fetch = async (url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Hello there.' }], usage: {} }) }; };
  await generateBrain({ provider: 'anthropic', model: 'claude-haiku-5-5', contents: CONTENTS, config: {} });
  assert.strictEqual(body.tools, undefined);
});

test('streamed tool calls are assembled from their pieces', async (t) => {
  const saved = global.fetch;
  t.after(() => { global.fetch = saved; });
  const events = [
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking. ' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_9', name: 'web_search' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"tallest ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'building"}' } },
    { type: 'content_block_stop', index: 1 },
  ];
  const payload = events.map((e) => `data: ${JSON.stringify(e)}\n`).join('');
  let sentBody;
  global.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, body: new Response(payload).body };
  };
  const chunks = [];
  for await (const chunk of streamBrain({ provider: 'anthropic', model: 'claude-haiku-5-5', contents: CONTENTS, config: { tools: TOOLS } })) chunks.push(chunk);
  assert.strictEqual(sentBody.stream, true);
  assert.strictEqual(sentBody.tools.length, 2);
  assert.strictEqual(chunks[0].text, 'Checking. ');
  const last = chunks[chunks.length - 1];
  assert.strictEqual(last.functionCalls[0].name, 'web_search');
  assert.deepStrictEqual(last.functionCalls[0].args, { query: 'tallest building' });
});

test('Claude requests carry prompt-caching markers on tools, fixed prompt and conversation', async (t) => {
  const saved = global.fetch;
  t.after(() => { global.fetch = saved; });
  const { CORE_SYSTEM_PROMPT } = require('../../api/prompts');
  let body;
  global.fetch = async (url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }) }; };
  await generateBrain({ provider: 'anthropic', model: 'claude-haiku-5-5', contents: CONTENTS, config: { tools: TOOLS, systemInstruction: `${CORE_SYSTEM_PROMPT}\n\nToday is Monday.` } });
  assert.strictEqual(body.tools[0].cache_control, undefined);
  assert.deepStrictEqual(body.tools[1].cache_control, { type: 'ephemeral' });
  assert.strictEqual(body.system[0].text, CORE_SYSTEM_PROMPT);
  assert.deepStrictEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.strictEqual(body.system[1].text, 'Today is Monday.');
  assert.strictEqual(body.system[1].cache_control, undefined);
  assert.deepStrictEqual(body.messages[0].content.at(-1).cache_control, { type: 'ephemeral' });
});

test('a streamed Claude reply is metered and a stream error is thrown', async (t) => {
  const saved = global.fetch;
  t.after(() => { global.fetch = saved; });
  const meter = require('../../api/services/usage-meter');
  const run = async (events) => {
    global.fetch = async () => ({ ok: true, body: new Response(events.map((e) => `data: ${JSON.stringify(e)}\n`).join('')).body });
    const out = [];
    for await (const c of streamBrain({ provider: 'anthropic', model: 'claude-haiku-5-5', contents: CONTENTS, config: {} })) out.push(c);
    return out;
  };
  const before = meter.lifetimeReport().calls;
  await run([{ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 100 } } }, { type: 'message_delta', usage: { output_tokens: 7 } }]);
  assert.strictEqual(meter.lifetimeReport().calls, before + 1);
  await assert.rejects(run([{ type: 'error', error: { message: 'overloaded' } }]), /overloaded/);
});
