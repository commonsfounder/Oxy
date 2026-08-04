const assert = require('node:assert/strict');
const test = require('node:test');

const taskManager = require('../../api/services/task-manager');
const { runAgentLoop, generatePlan, reflectOnResults } = require('../../api/services/agent-orchestrator');
const { safeAgentTaskSummary } = require('../../api');
const { buildAgentContext } = require('../../api/services/agent-context');
const { normalizeWorkspacePath, validateWorkspaceContent } = require('../../api/services/agent-workspace');
const { resolveModelRoute, validateModelRouteInput, publicModelRouting } = require('../../api/services/model-routing');
const { toAnthropicMessages, geminiToolsToAnthropic } = require('../../api/services/brain-provider');
const { normaliseContinuityPayload, importedMemoryCandidates, importContinuity } = require('../../api/services/agent-continuity');
const { writeWorkspaceFiles } = require('../../api/services/agent-workspace');

// Minimal supabase double that records every call, so "how many round-trips did this take"
// is assertable. A per-message await inside a loop is the difference between an import that
// finishes and one that dies on the Cloud Run request timeout half-written.
function recordingSupabase({ failOn = null, existingFiles = [] } = {}) {
  const log = { trips: 0, inserts: [], updates: [], rows: 0 };
  const from = (table) => {
    log.trips++;
    const settle = (data) => {
      if (failOn === table) return Promise.resolve({ data: null, error: new Error(`${table} exploded`) });
      return Promise.resolve({ data, error: null });
    };
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      in: () => chain,
      ilike: () => chain,
      limit: () => settle([]),
      maybeSingle: () => settle({ id: 'ws-1' }),
      single: () => settle({ id: 'import-1', status: 'claimed' }),
      then: (resolve) => settle(table === 'agent_workspace_files' ? existingFiles : []).then(resolve),
      insert: (rows) => {
        const list = Array.isArray(rows) ? rows : [rows];
        log.inserts.push({ table, count: list.length, rows: list });
        log.rows += list.length;
        return chain;
      },
      upsert: (rows) => {
        const list = Array.isArray(rows) ? rows : [rows];
        log.inserts.push({ table, count: list.length, rows: list, upsert: true });
        return chain;
      },
      update: (patch) => {
        log.updates.push({ table, patch });
        return chain;
      }
    };
    return chain;
  };
  return { supabase: { from }, log };
}

test('agentic task manager module loads and has expected functions', () => {
  assert.ok(typeof taskManager.createTask === 'function');
  assert.ok(typeof taskManager.listTasks === 'function');
  assert.ok(typeof taskManager.getTask === 'function');
  assert.ok(typeof taskManager.updateTask === 'function');
});

test('agent OS context keeps identity, profile, preferences, goals, and relationships in one safe shape', () => {
  const context = buildAgentContext({
    memories: [
      { source: 'manual_profile', content: 'Identity\n- Lives in London\nWork\n- Building Milgrain\nRelationships\n- Partner prefers quiet mornings' },
      { source: 'fact', content: 'Prefers direct communication' }
    ],
    preferences: [
      { key: 'autonomy', value: 'Balanced' },
      { key: 'preferred_transport_mode', value: 'walking' },
      { key: 'concierge_account.balance', value: '100' }
    ],
    tasks: [{
      id: 'goal-1',
      goal: 'Watch for a cheaper flight',
      status: 'running',
      autonomy: 'Proactive',
      metadata: { guardMode: true },
      current_step: 2,
      updated_at: '2026-08-04T10:00:00Z'
    }],
    connectors: [{ connector_id: 'google' }, { connector_id: 'microsoft' }]
  });

  assert.equal(context.agent.name, 'Millie');
  assert.deepEqual(context.profile.sections.work, ['Work', '- Building Milgrain']);
  assert.deepEqual(context.profile.sections.relationships, ['Relationships', '- Partner prefers quiet mornings']);
  assert.deepEqual(context.preferences, {
    autonomy: 'Balanced',
    preferred_transport_mode: 'walking'
  });
  assert.equal(context.goals[0].guardMode, true);
  assert.deepEqual(context.connectedApps, ['google', 'microsoft']);
  assert.doesNotMatch(JSON.stringify(context), /concierge_account|100/);
});

test('agent workspace paths and content are bounded before persistence', () => {
  assert.equal(normalizeWorkspacePath('./projects/milgrain/notes.md'), 'projects/milgrain/notes.md');
  assert.throws(() => normalizeWorkspacePath('../outside.txt'), /Invalid workspace path/);
  assert.throws(() => validateWorkspaceContent('x'.repeat(512 * 1024 + 1)), /too large/);
  assert.equal(validateWorkspaceContent('hello'), 'hello');
});

test('agent workspace API exposes files and persistent sessions', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../api/index.js'), 'utf8');
  assert.match(source, /app\.get\('\/agent\/workspace'/);
  assert.match(source, /app\.put\('\/agent\/workspace\/files'/);
  assert.match(source, /app\.post\('\/agent\/workspace\/sessions'/);
});

test('model independence validates and resolves a per-user provider route', () => {
  const route = validateModelRouteInput({ provider: 'anthropic', model: 'claude-sonnet-5' });
  assert.deepEqual(route, { provider: 'anthropic', model: 'claude-sonnet-5' });
  assert.equal(validateModelRouteInput({ provider: 'unknown' }).error, 'Choose a supported model provider.');
  const resolved = resolveModelRoute({ model_route_provider: 'local', model_route_model: 'llama3.2' });
  assert.equal(resolved.provider, 'local');
  assert.equal(resolved.model, 'llama3.2');
  assert.equal(resolved.source, 'user');
  assert.ok(Array.isArray(publicModelRouting({}).providers));
});

test('model independence preserves tool calls and tool results for Claude', () => {
  const messages = toAnthropicMessages([
    { role: 'user', parts: [{ text: 'Find it' }] },
    { role: 'model', parts: [{ functionCall: { id: 'toolu_1', name: 'find_place', args: { query: 'home' } } }] },
    { role: 'function', parts: [{ functionResponse: { id: 'toolu_1', name: 'find_place', response: { result: '{"success":true}' } } }] }
  ]);
  assert.equal(messages[1].content[0].type, 'tool_use');
  assert.equal(messages[1].content[0].id, 'toolu_1');
  assert.equal(messages[2].content[0].type, 'tool_result');
  assert.equal(messages[2].content[0].tool_use_id, 'toolu_1');
  const tools = geminiToolsToAnthropic([{ functionDeclarations: [{ name: 'find_place', description: 'Find a place', parameters: { type: 'OBJECT', properties: {} } }] }]);
  assert.equal(tools[0].input_schema.type, 'object');
});

test('model routing API exposes explicit provider selection', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../api/index.js'), 'utf8');
  assert.match(source, /app\.get\('\/model-routing'/);
  assert.match(source, /app\.put\('\/model-routing'/);
  assert.match(source, /chatProvider/);
});

test('continuity import normalises ChatGPT-style history and derives bounded memories', () => {
  const imported = normaliseContinuityPayload({
    source: 'chatgpt',
    conversations: [{
      title: 'Milgrain build',
      mapping: {
        a: { message: { author: { role: 'user' }, content: { parts: ['I am building Milgrain and prefer direct communication.'] }, create_time: 1 } },
        b: { message: { author: { role: 'assistant' }, content: { parts: ['Keep the next step small.'] }, create_time: 2 } }
      }
    }],
    projects: [{ title: 'Milgrain', description: 'I am building a household agent.' }],
    instructions: 'I prefer concise answers.'
  });
  assert.equal(imported.source, 'chatgpt');
  assert.equal(imported.conversations[0].messages.length, 2);
  assert.equal(imported.instructions[0], 'I prefer concise answers.');
  assert.ok(importedMemoryCandidates(imported).some(line => /building Milgrain/i.test(line)));
  assert.ok(JSON.stringify(imported).length < 20000);
});

test('continuity import batches message writes instead of one round-trip per message', async () => {
  const conversations = Array.from({ length: 50 }, (_, i) => ({
    id: 'c' + i,
    title: 'Conversation ' + i,
    messages: Array.from({ length: 60 }, (_, j) => ({
      role: j % 2 ? 'assistant' : 'user',
      content: 'message body ' + j
    }))
  }));
  const { supabase, log } = recordingSupabase();

  const result = await importContinuity(supabase, 'user-1', { source: 'chatgpt', conversations });

  assert.equal(result.imported.messages, 3000);
  const messageRows = log.inserts
    .filter(entry => entry.table === 'conversations')
    .reduce((total, entry) => total + entry.count, 0);
  assert.equal(messageRows, 3000, 'every message must still be written');
  assert.ok(log.trips < 30, `3000 messages took ${log.trips} round-trips; batching is not working`);
  assert.ok(
    log.inserts.every(entry => entry.count <= 500),
    'batches must stay bounded so a single insert cannot exceed the payload limit'
  );
});

test('continuity import claims its record before writing and completes it after', async () => {
  const { supabase, log } = recordingSupabase();
  await importContinuity(supabase, 'user-1', {
    source: 'claude',
    conversations: [{ id: 'c1', title: 'T', messages: [{ role: 'user', content: 'hello there friend' }] }]
  });

  const claim = log.inserts.find(entry => entry.table === 'agent_imports');
  assert.equal(claim.rows[0].status, 'running', 'the import row must exist before any history is written');
  const firstHistoryWrite = log.inserts.findIndex(entry => entry.table === 'conversations');
  assert.ok(log.inserts.indexOf(claim) < firstHistoryWrite, 'the claim must precede the history writes');
  assert.deepEqual(log.updates.map(u => u.patch.status), ['completed']);
});

test('a failed continuity import marks its record failed rather than leaving it running', async () => {
  const { supabase, log } = recordingSupabase({ failOn: 'conversations' });
  await assert.rejects(
    () => importContinuity(supabase, 'user-1', {
      source: 'chatgpt',
      conversations: [{ id: 'c1', title: 'T', messages: [{ role: 'user', content: 'hello there friend' }] }]
    }),
    /conversations exploded/
  );
  assert.deepEqual(log.updates.map(u => u.patch.status), ['failed']);
});

test('continuity import rejects an oversized payload before doing the normalisation work', async () => {
  const { supabase, log } = recordingSupabase();
  const huge = { source: 'generic', documents: [{ name: 'big.txt', content: 'x'.repeat(9 * 1024 * 1024) }] };
  await assert.rejects(() => importContinuity(supabase, 'user-1', huge), /Import is too large/);
  assert.equal(log.trips, 0, 'nothing should be read or written for a rejected import');
});

test('batched workspace writes dedupe paths and bump versions off the existing row', async () => {
  const { supabase, log } = recordingSupabase({ existingFiles: [{ path: 'notes.md', version: 3 }] });
  await writeWorkspaceFiles(supabase, 'user-1', [
    { path: 'notes.md', content: 'first' },
    { path: 'notes.md', content: 'second' },
    { path: './fresh.md', content: 'new file' }
  ], { id: 'ws-1' });

  const upsert = log.inserts.find(entry => entry.upsert);
  assert.equal(upsert.rows.length, 2, 'duplicate paths must collapse — Postgres rejects a double ON CONFLICT hit');
  const byPath = Object.fromEntries(upsert.rows.map(row => [row.path, row]));
  assert.equal(byPath['notes.md'].content, 'second', 'last write wins');
  assert.equal(byPath['notes.md'].version, 4, 'version continues from the stored row');
  assert.equal(byPath['fresh.md'].version, 1);
});

test('continuity API exposes import history without returning raw imported payloads', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../api/index.js'), 'utf8');
  assert.match(source, /app\.get\('\/agent\/continuity'/);
  assert.match(source, /app\.post\('\/agent\/continuity\/import'/);
  assert.match(source, /supportedSources/);
});

test('tool ecosystem and browser agent expose one safe capability catalog', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../api/index.js'), 'utf8');
  assert.match(source, /app\.get\('\/agent\/tools'/);
  assert.match(source, /app\.get\('\/agent\/browser'/);
  assert.match(source, /checkout_review/);
  assert.match(source, /executionMode: contract\.executionMode/);
  assert.match(source, /app\.get\('\/agent\/permissions'/);
  assert.match(source, /app\.get\('\/agent\/audit'/);
  assert.match(source, /undo: null/);
  assert.match(source, /agentTasks: data\.agent_tasks/);
  assert.match(source, /continuityImports: data\.agent_imports/);
});

test('agent orchestrator exports core agentic functions', () => {
  assert.ok(typeof runAgentLoop === 'function');
  assert.ok(typeof generatePlan === 'function');
  assert.ok(typeof reflectOnResults === 'function');
});

test('persistent task runs expose a stable existing-task seam', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../api/services/agent-orchestrator.js'), 'utf8');
  assert.match(source, /existingTaskId\s*=\s*null/);
  assert.match(source, /existingTaskId\s*\?/);
});

test('persistent task run marks running before starting the background loop', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../api/index.js'), 'utf8');
  const routeStart = source.indexOf("app.post('/agent/tasks/:id/run'");
  const routeEnd = source.indexOf("app.post('/agent/simulate'", routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.ok(route.indexOf("updateTask(userId, task.id, { status: 'running' })") < route.indexOf('runAgenticLoop({'));
});

test('persistent task summaries keep activity useful without exposing raw payloads', () => {
  const summary = safeAgentTaskSummary({
    id: 'task-1',
    goal: 'Find a laptop for me at https://example.com',
    status: 'completed',
    current_step: 2,
    autonomy: 'Balanced',
    metadata: { guardMode: true, rawSecret: 'do-not-return' },
    results: [{
      action: 'web_browse',
      input: { email: 'person@example.com', password: 'secret' },
      result: {
        success: true,
        text: 'Compared options at https://example.com for person@example.com',
        actionSummary: 'Compared 3 options'
      }
    }]
  });

  assert.equal(summary.guard_mode, true);
  assert.equal(summary.results[0].summary, 'Compared 3 options');
  assert.equal(summary.goal, 'Find a laptop for me at');
  assert.doesNotMatch(JSON.stringify(summary), /person@example\.com|do-not-return|password|secret|https:\/\//);
  assert.equal(summary.results[0].action, 'web_browse');
});

test('persistent task controls route carries guard mode into the agent loop', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../api/index.js'), 'utf8');
  const routeStart = source.indexOf("app.patch('/agent/tasks/:id'");
  const routeEnd = source.indexOf("app.post('/agent/tasks/:id/run'", routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /updates\.metadata\s*=\s*\{\s*\.\.\.\(task\.metadata \|\| \{\}\), guardMode\s*\}/);
  assert.match(source, /context: \{ autonomy: task\.autonomy, guardMode: task\.metadata\?\.guardMode === true \}/);
});

test('action contracts now include new agentic tools', () => {
  const { ACTION_CONTRACTS } = require('../../api/action-contracts');
  assert.ok(ACTION_CONTRACTS.web_browse);
  assert.ok(ACTION_CONTRACTS.calculate);
  assert.ok(ACTION_CONTRACTS.create_agent_task);
  assert.ok(ACTION_CONTRACTS.simulate_actions);
});
