// Agent orchestrator - no circular deps. Client and model injected or required carefully.
let modernGenAI;
let PRIMARY_CHAT_MODEL = 'gemini-3-flash-preview';

try {
  const { GoogleGenAI: ModernGoogleGenAI } = require('@google/genai');
  modernGenAI = new ModernGoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
  PRIMARY_CHAT_MODEL = process.env.OXY_REASONING_MODEL || process.env.GEMINI_MODEL || PRIMARY_CHAT_MODEL;
} catch (e) {
  console.warn('[agent-orchestrator] Gemini client init warning:', e.message);
}

const { buildToolsForGemini } = require('../action-contracts');
const taskManager = require('./task-manager');

// Simple in-memory for traces during a run; production should persist
const runTraces = new Map();

// Extract function calls from ONE source, not both: resp.functionCalls (when the SDK
// provides it) is a derived view over the same candidates[0].content.parts array, not an
// independent signal. Reading both and pushing into the same list double-counted every real
// call — confirmed live (2026-07-11): a single run_browser_task call came back as two
// identical-args entries, which then executed twice sequentially, roughly doubling
// wall-clock time on an already-slow action for no benefit. Pure/exported so this exact
// regression is unit-testable without a real Gemini client.
function extractToolCalls(resp) {
  if (resp?.functionCalls?.length) {
    return resp.functionCalls.map(fc => ({ name: fc.name, args: fc.args || {} }));
  }
  const parts = resp?.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => p.functionCall).map(p => ({ name: p.functionCall.name, args: p.functionCall.args || {} }));
}

function extractSpokenFromResponseSafe(resp) {
  if (!resp) return '';
  try {
    if (typeof resp.text === 'function') return (resp.text() || '').trim();
    if (resp.text) return String(resp.text).trim();
    const c = resp.candidates?.[0];
    if (c?.content?.parts) {
      return c.content.parts.filter(p => p.text).map(p => p.text).join(' ').trim();
    }
  } catch {}
  return '';
}

function createAgentTrace(userId, goal) {
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const trace = {
    id,
    userId,
    goal,
    steps: [],
    startTime: Date.now(),
    status: 'running',
    plan: null,
    finalSpoken: '',
    actionsTaken: []
  };
  runTraces.set(id, trace);
  return trace;
}

function logAgentStep(trace, step) {
  if (!trace) return;
  trace.steps.push({ ts: Date.now(), ...step });
  console.log(`[agent:${trace.id}] ${step.type || 'step'}: ${JSON.stringify(step).slice(0, 200)}`);
}

async function callGeminiWithTools(modelName, contents, config, trace = null) {
  const req = { model: modelName, contents, config };
  const resp = trace
    ? await trace.run?.('gemini.agent.generate', () => modernGenAI.models.generateContent(req)) || await modernGenAI.models.generateContent(req)
    : await modernGenAI.models.generateContent(req);
  return resp;
}

/**
 * Core ReAct-style agent loop.
 * Runs up to maxIterations: generate (with tools), execute any function calls, feed results back as "function" responses, repeat.
 * Returns final spoken text + executed actions + trace.
 */
async function runAgentLoop({
  userId,
  initialMessage,
  dynamicSystemPrompt,
  baseHistory = [],
  useSearch = false,
  modelName = PRIMARY_CHAT_MODEL || 'gemini-3-flash-preview',
  maxIterations = 6,
  context = {},
  executeActionsFn,
  trace = null,
  onStep = null,
  persistTask = false
}) {
  const agentTrace = createAgentTrace(userId, initialMessage);
  let persistedTask = null;
  if (persistTask) {
    try {
      persistedTask = await taskManager.createTask(userId, initialMessage, { autonomy: context.autonomy || 'Active' });
      agentTrace.persistedTaskId = persistedTask.id;
    } catch (e) {}
  }

  const contents = [...baseHistory, { role: 'user', parts: [{ text: initialMessage }] }];
  const executedActions = [];
  let spoken = '';
  let lastToolResultsText = '';

  // Cream-of-the-crop: auto plan for complex goals. Keyword-gated only — message length
  // alone used to also trigger this (`initialMessage.length > 50`), which fired on almost
  // every real shopping goal ("order a macbook pro 14 inch space black 512gb from
  // johnlewis.com" is 60+ chars) for a single-action run_browser_task request that gets no
  // benefit from a separate planning call, costing a full hidden ~4-5s Gemini round trip
  // before the first real turn even starts. Word-boundaried (`\b`) — the un-boundaried
  // version matched "book" inside "MacBook", so this fired on every MacBook order anyway
  // despite the keyword gate above.
  if (/\b(plan|book|research|find|organize|handle|arrange)\b/i.test(initialMessage)) {
    try {
      const plan = await generatePlan(userId, initialMessage, context.summary || '');
      if (plan?.steps?.length > 1) {
        logAgentStep(agentTrace, { type: 'auto_plan', plan: plan.title });
        // Inject plan into context for agent
        contents.push({ role: 'user', parts: [{ text: `Internal plan: ${JSON.stringify(plan.steps)}` }] });
      }
    } catch {}
  }

  const baseConfig = {
    systemInstruction: dynamicSystemPrompt,
    temperature: 0.2,
    topP: 0.8,
    tools: buildToolsForGemini ? buildToolsForGemini(useSearch) : [{ functionDeclarations: [] }],
    // googleSearch alongside functionDeclarations 400s unless server-side tool
    // invocations are enabled — this is what silently killed grounded turns.
    toolConfig: { functionCallingConfig: { mode: 'AUTO' }, ...(useSearch ? { includeServerSideToolInvocations: true } : {}) }
  };

  for (let i = 0; i < maxIterations; i++) {
    logAgentStep(agentTrace, { type: 'think', iteration: i + 1 });

    if (onStep) onStep({ phase: 'thinking', iteration: i + 1 });

    let resp;
    try {
      resp = await callGeminiWithTools(modelName, contents, baseConfig, trace);
    } catch (err) {
      logAgentStep(agentTrace, { type: 'error', error: err.message });
      // Retry once on transient error for cream-of-crop reliability
      if (i < maxIterations - 1) {
        await new Promise(r => setTimeout(r, 500));
        try {
          resp = await callGeminiWithTools(modelName, contents, baseConfig, trace);
        } catch (e2) {
          logAgentStep(agentTrace, { type: 'error_retry_failed', error: e2.message });
          agentTrace.status = 'error';
          break;
        }
      } else {
        agentTrace.status = 'error';
        break;
      }
    }

    const toolCalls = extractToolCalls(resp);
    // The raw response parts (text + functionCall parts together) are replayed verbatim as
    // this iteration's "model" turn below — a SEPARATE use from toolCalls, which is why this
    // wasn't folded into extractToolCalls itself.
    const responseParts = resp?.candidates?.[0]?.content?.parts || [];

    spoken = extractSpokenFromResponseSafe(resp) || spoken;

    if (toolCalls.length === 0) {
      // No more tools — final answer
      logAgentStep(agentTrace, { type: 'final_answer', spoken: spoken?.slice(0, 120) });
      agentTrace.status = 'completed';
      break;
    }

    // Convert to internal action shape
    const actions = toolCalls.map(tc => ({ type: tc.name, input: tc.args || {} }));

    logAgentStep(agentTrace, { type: 'tool_calls', actions: actions.map(a => a.type) });

    if (onStep) onStep({ phase: 'executing', actions });

    // Execute one model turn's tool calls as an ordered batch so compound
    // requests preserve dependencies and result order.
    let results = [];
    if (typeof executeActionsFn === 'function') {
      try {
        results = await executeActionsFn(userId, actions, { ...context, agentIteration: i, sequential: true }, trace);
      } catch (e) {
        results = actions.map(a => ({ action: a.type, result: { success: false, error: e.message } }));
      }
    } else {
      results = actions.map(a => ({ action: a.type, result: { success: true, text: `Executed ${a.type}` } }));
    }

    executedActions.push(...results);

    // Feed results back into conversation for next think
    const functionResponses = [];
    results.forEach((r, idx) => {
      const action = actions[idx] || {};
      const resultText = JSON.stringify(r.result || r || {});
      functionResponses.push({
        role: 'function',
        parts: [{ functionResponse: { name: action.type || 'unknown', response: { result: resultText } } }]
      });
      lastToolResultsText += `\n[${action.type || 'action'} result]: ${resultText.slice(0, 300)}`;
    });

    // Append model turn that led to tools + the function responses
    contents.push({ role: 'model', parts: responseParts.length ? responseParts : [{ text: spoken || '...' }] });
    contents.push(...functionResponses);

    logAgentStep(agentTrace, { type: 'observe', results: results.map(r => r.action) });

    if (onStep) onStep({ phase: 'observed', results });

    // Cream-of-the-crop: mid-loop reflection for self-correction. Skipped when a result
    // already tells us the goal isn't achieved yet (e.g. run_browser_task's
    // continuesBrowsing: true) — asking a full extra model call "did we achieve the goal?"
    // when the action itself already answered "not yet, still working" was a real, silent
    // ~2-10s cost on every iteration for zero behavioral effect (reflection.nextAction is
    // logged, never consulted for control flow).
    // Fire-and-forget, not awaited: nothing downstream branches on `reflection` (it was
    // already dead for control flow before this change — see comment above), so blocking
    // the response on it was pure latency with no payoff. Logged whenever it resolves,
    // even if that's after this turn has already answered the user.
    const stillInProgress = results.some((r) => r.result?.continuesBrowsing === true);
    if (i > 0 && results.length > 0 && !stillInProgress) {
      reflectOnResults(initialMessage, actions, results)
        .then((reflection) => {
          if (!reflection.achieved && reflection.nextAction) {
            logAgentStep(agentTrace, { type: 'reflection', ...reflection });
          }
        })
        .catch(() => {});
    }

    // Safety: if many actions or high risk, may stop early in future
  }

  agentTrace.actionsTaken = executedActions;
  agentTrace.finalSpoken = spoken;
  if (agentTrace.status === 'running') agentTrace.status = 'completed';

  if (persistedTask) {
    try {
      await taskManager.updateTask(userId, persistedTask.id, {
        status: agentTrace.status === 'completed' ? 'completed' : 'running',
        results: executedActions,
        plan: agentTrace.plan
      });
      await taskManager.saveTrace(persistedTask.id, userId, agentTrace.steps.length, 'agent_run_complete', { spoken, actions: executedActions.length });
    } catch (e) {}
  }

  // Never claim "Done." when the loop died without doing anything — that reads as a
  // (false) success to the user. Surface the failure so they know to retry.
  const fallback = agentTrace.status === 'error' && !executedActions.length
    ? "I hit a problem finishing that — give me a moment and try again."
    : 'Done.';
  return {
    spoken: spoken || lastToolResultsText || fallback,
    actions: executedActions,
    traceId: agentTrace.id,
    iterations: agentTrace.steps.length,
    agentTrace,
    taskId: persistedTask ? persistedTask.id : null
  };
}

// Simple planner: ask model to output a structured plan first
async function generatePlan(userId, goal, contextSummary = '', modelName = PRIMARY_CHAT_MODEL) {
  // For broad/open-ended goals like "make money", first research current opportunities using available tools/knowledge
  let researchContext = contextSummary;
  const broadGoalKeywords = /money|earn|income|side hustle|monetize|profit|cash|freelance|gig/i;
  if (broadGoalKeywords.test(goal)) {
    // Simulate or use web_search logic in planning for fresh ideas
    researchContext += `\nResearch context: Current popular ways include freelance on platforms, content creation, selling digital products, gig economy (delivery, rides), affiliate, investing basics, consulting based on skills. Use web_search or browse for live opportunities. Use the concierge account to fund small tests (e.g. ads, boosts) and receive earnings.`;
  }

  const planPrompt = `You are an expert planner for a personal AI assistant.

User goal: ${goal}

Available context summary:
${researchContext}

Return ONLY a JSON object:
{
  "title": "short title",
  "steps": [
    { "id": 1, "description": "concise step", "actionType": "optional suggested action name or null", "dependsOn": [] }
  ],
  "risks": ["list of risks"],
  "estimatedEffort": "low|medium|high",
  "researchNeeded": ["any specific searches or browses to do first"],
  "accountUsage": "how to use concierge account (spend/fund/receive) if relevant"
}

Keep steps actionable and minimal. For broad goals like making money, prioritize low-risk, quick-start steps using available tools (web research, profile setup, persistent task creation, account for funding). Focus on legitimate, user-skill-aligned ideas. Include account usage for seeding or receiving.`;

  const resp = await modernGenAI.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts: [{ text: planPrompt }] }],
    config: { temperature: 0.1, maxOutputTokens: 800 }
  });

  const text = extractSpokenFromResponseSafe(resp);
  try {
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { title: goal.slice(0, 60), steps: [{ id: 1, description: goal, actionType: null }], risks: [], estimatedEffort: 'medium' };
  }
}

// Reflection step: after execution, reflect and suggest next or correction
async function reflectOnResults(goal, actionsTaken, results, modelName = PRIMARY_CHAT_MODEL) {
  const summary = `Goal: ${goal}\nActions: ${JSON.stringify(actionsTaken.map(a => a.action))}\nResults summary: ${JSON.stringify(results.map(r => ({a: r.action, ok: r.result?.success !== false})))}`;
  const prompt = `You are the assistant's reflection module. Analyze if the goal was achieved. Output JSON: { "achieved": boolean, "summary": "one sentence", "nextAction" : "null or suggested follow up action type", "issues": [] }`;
  const resp = await modernGenAI.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts: [{ text: prompt + '\n\n' + summary }] }],
    config: { temperature: 0.2 }
  });
  const t = extractSpokenFromResponseSafe(resp);
  try { return JSON.parse(t.replace(/```/g,'').trim()); } catch { return { achieved: true, summary: 'Completed.', nextAction: null, issues: [] }; }
}

// Simple branching/conditional execution for plans (advanced orchestration)
async function executePlanWithBranching(userId, plan, context = {}, executeFn) {
  const results = [];
  for (const step of (plan.steps || [])) {
    const shouldRun = !step.condition || evaluateSimpleCondition(step.condition, results, context);
    if (!shouldRun) continue;
    const res = await (executeFn || (async () => ({})))(userId, step.action || step, context);
    results.push({ step: step.id || step.description, result: res });
    if (step.onFail && res?.success === false) {
      // branch on fail
      await executePlanWithBranching(userId, { steps: step.onFail }, context, executeFn);
    }
  }
  return results;
}

function evaluateSimpleCondition(cond, prevResults, ctx) {
  // very simple: "last_success" or "contains:foo"
  if (cond === 'last_success') return prevResults.length && prevResults[prevResults.length-1].result?.success !== false;
  if (typeof cond === 'string' && cond.startsWith('contains:')) {
    const needle = cond.split(':')[1];
    return JSON.stringify(prevResults).includes(needle) || JSON.stringify(ctx).includes(needle);
  }
  return true;
}

// Multi-agent stub: delegate to specialist
async function delegateToSpecialist(specialist, goal, context) {
  // In real would call sub model or different prompt
  return { specialist, handled: goal, note: 'Delegated (stub - extend with specialist prompts)' };
}

module.exports = {
  runAgentLoop,
  generatePlan,
  reflectOnResults,
  createAgentTrace,
  logAgentStep,
  executePlanWithBranching,
  delegateToSpecialist,
  extractToolCalls
};
