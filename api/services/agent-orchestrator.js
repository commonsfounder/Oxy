// Agent orchestrator - no circular deps. Client and model injected or required carefully.
// The model call goes through the brain-provider seam, so this loop follows whatever
// OXY_BRAIN_PROVIDER selects (OpenAI by default) without knowing which provider it is.
const { defaultModelForProvider } = require('./model-routing');
let PRIMARY_CHAT_MODEL = defaultModelForProvider(process.env.OXY_BRAIN_PROVIDER || 'openai', 'reasoning');

// Held as the module object, not destructured: the loop's behaviour around a failing or
// slow model (retries, checkpointing, resume) is only testable if the brain call can be
// swapped, and a destructured binding freezes it at import time.
const brainProvider = require('./brain-provider');
const { buildToolsForGemini } = require('../action-contracts');
const taskManager = require('./task-manager');
const { isTravelPlanningRequest } = require('./travel-concierge');

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
    return resp.functionCalls.map(fc => ({ name: fc.name, args: fc.args || {}, id: fc.id || null }));
  }
  const parts = resp?.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => p.functionCall).map((p, index) => ({
    name: p.functionCall.name,
    args: p.functionCall.args || {},
    id: p.functionCall.id || `call_${String(p.functionCall.name || 'fn').slice(0, 32)}_${index}`
  }));
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

function replacePendingToolResult(contents, entry) {
  if (!Array.isArray(contents) || !entry?.action) return contents;
  const next = JSON.parse(JSON.stringify(contents));
  const expectedId = entry._toolCallId || null;
  for (const turn of next) {
    for (const part of turn?.parts || []) {
      const response = part?.functionResponse;
      if (!response || response.name !== entry.action || (expectedId && response.id !== expectedId)) continue;
      let parsed = null;
      try { parsed = JSON.parse(response.response?.result || ''); } catch {}
      if (parsed?.pending !== true) continue;
      response.response.result = JSON.stringify(entry.result || {});
      return next;
    }
  }
  return next;
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

async function callGeminiWithTools(modelName, contents, config, trace = null, provider = null) {
  const req = { provider, model: modelName, contents, config };
  const resp = trace
    ? await trace.run?.('brain.agent.generate', () => brainProvider.callToolsBrain(req)) || await brainProvider.callToolsBrain(req)
    : await brainProvider.callToolsBrain(req);
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
  provider = null,
  maxIterations = 6,
  context = {},
  executeActionsFn,
  trace = null,
  onStep = null,
  persistTask = false,
  existingTaskId = null,
  resumeNote = null,
  resumeAction = null
}) {
  const agentTrace = createAgentTrace(userId, initialMessage);
  let persistedTask = null;
  if (persistTask) {
    try {
      // A task started from the persistent-work surface already has an identity.
      // Reusing it keeps the run, results, and later history attached to the same
      // user-visible goal instead of silently creating a duplicate row.
      persistedTask = existingTaskId
        ? await taskManager.getTask(userId, existingTaskId)
        : await taskManager.createTask(userId, initialMessage, {
          autonomy: context.autonomy || 'Active',
          metadata: {
            ...(context.taskMetadata || {}),
            ...(context.modelRoute ? { modelRoute: context.modelRoute } : {}),
            ...(context.useSearch !== undefined ? { useSearch: Boolean(context.useSearch) } : {})
          }
        });
      if (!persistedTask) throw new Error('Persistent task not found');
      agentTrace.persistedTaskId = persistedTask.id;
    } catch (e) {
      // Background/scheduled work can still run without persistence if the
      // optional task table is unavailable. A user explicitly resuming a known
      // task is different: silently detaching that run would break continuity.
      if (existingTaskId) throw e;
    }
  }

  // Resume from where a dead instance left off. Without this a recycled run restarted the
  // goal from scratch — re-executing every action it had already performed.
  const resumeFrom = (persistedTask && persistedTask.checkpoint) || null;
  const contents = resumeFrom?.contents?.length
    ? [...resumeFrom.contents]
    : [...baseHistory, { role: 'user', parts: [{ text: initialMessage }] }];
  const executedActions = [...(resumeFrom?.executedActions || [])];
  if (resumeAction) {
    const pendingIndex = executedActions.findLastIndex(entry =>
      entry?.action === resumeAction.action && entry?.result?.pending === true
    );
    if (pendingIndex >= 0) executedActions[pendingIndex] = resumeAction;
    else if (!executedActions.some(entry => entry?.action === resumeAction.action && entry?.result?.success === true)) {
      executedActions.push(resumeAction);
    }
  }
  const resumedContents = resumeAction ? replacePendingToolResult(contents, resumeAction) : contents;
  const startIteration = Number.isFinite(resumeFrom?.iteration) ? resumeFrom.iteration + 1 : 0;
  // Approval may arrive after the run parked on its final allowed iteration. Give
  // the resumed goal at least one model turn instead of falling through as completed.
  const effectiveMaxIterations = Math.max(
    Number.isFinite(resumeFrom?.maxIterations) ? resumeFrom.maxIterations : maxIterations,
    startIteration + 1
  );
  let spoken = resumeFrom?.spoken || '';
  let lastToolResultsText = '';

  if (resumeFrom) {
    logAgentStep(agentTrace, { type: 'resumed', fromIteration: startIteration, actionsAlready: executedActions.length });
    // The checkpoint ends on a tool result saying "waiting for approval". Without this the
    // model reads that as still-blocked and asks for the same approval again.
    if (resumeNote) resumedContents.push({ role: 'user', parts: [{ text: resumeNote }] });
    if (context.continuationMessage) {
      resumedContents.push({
        role: 'user',
        parts: [{ text: `The user has continued this goal with: ${String(context.continuationMessage).slice(0, 1200)}` }]
      });
    }
    if (resumeFrom.truncated) {
      // The checkpoint had to drop history to fit. Say so in-band rather than letting the
      // model infer a gap it can't see.
      resumedContents.push({ role: 'user', parts: [{ text: `Continuing an interrupted run of: ${initialMessage}. Earlier steps are summarised in the results already recorded; do not repeat completed work.` }] });
    }
  }

  async function checkpoint(iteration) {
    if (!persistedTask) return;
    try {
      await taskManager.saveCheckpoint(userId, persistedTask.id, {
        iteration,
        maxIterations,
        contents: resumedContents,
        executedActions,
        spoken,
        goal: initialMessage
      });
    } catch {
      // A checkpoint write failing must not kill a run that is otherwise working; the
      // stale-run sweep is the backstop if this keeps failing.
    }
  }

  // Cream-of-the-crop: auto plan for complex goals. Keyword-gated only — message length
  // alone used to also trigger this (`initialMessage.length > 50`), which fired on almost
  // every real shopping goal ("order a macbook pro 14 inch space black 512gb from
  // johnlewis.com" is 60+ chars) for a single-action run_browser_task request that gets no
  // benefit from a separate planning call, costing a full hidden ~4-5s Gemini round trip
  // before the first real turn even starts. Word-boundaried (`\b`) — the un-boundaried
  // version matched "book" inside "MacBook", so this fired on every MacBook order anyway
  // despite the keyword gate above.
  // Trip-planning requests are excluded: plan_itinerary already IS the single research+build step
  // (real grounded search feeding itinerary generation in one call). Auto-planning here used to
  // inject a generic "research each piece separately" framing ahead of the model's first real
  // turn, which measurably steered it into free-form web_search + hand-written prose instead of
  // the actual tool — defeating the point of a structured, savable, editable itinerary (live
  // verified 2026-08-08: "Plan me a Saturday day trip to Bath..." never called plan_itinerary at all
  // until this exclusion was added).
  if (/\b(plan|book|research|find|organize|handle|arrange)\b/i.test(initialMessage) && !isTravelPlanningRequest(initialMessage)) {
    try {
      const plan = await generatePlan(userId, initialMessage, context.summary || '', modelName, provider);
      if (plan?.steps?.length > 1) {
        logAgentStep(agentTrace, { type: 'auto_plan', plan: plan.title });
        // Inject plan into context for agent
        resumedContents.push({ role: 'user', parts: [{ text: `Internal plan: ${JSON.stringify(plan.steps)}` }] });
      }
    } catch {}
  }

  const baseConfig = {
    // dynamicSystemPrompt is always a fully-composed prompt now (built by the caller via
    // buildSystemPrompt), not a fragment needing a static prefix.
    systemInstruction: dynamicSystemPrompt,
    temperature: 0.2,
    topP: 0.8,
    tools: buildToolsForGemini ? buildToolsForGemini(useSearch) : [{ functionDeclarations: [] }],
    // googleSearch alongside functionDeclarations 400s unless server-side tool
    // invocations are enabled — this is what silently killed grounded turns.
    toolConfig: { functionCallingConfig: { mode: 'AUTO' }, ...(useSearch ? { includeServerSideToolInvocations: true } : {}) }
  };

  await checkpoint(startIteration - 1);

  for (let i = startIteration; i < effectiveMaxIterations; i++) {
    logAgentStep(agentTrace, { type: 'think', iteration: i + 1 });

    if (onStep) onStep({ phase: 'thinking', iteration: i + 1 });

    let resp;
    try {
      resp = await callGeminiWithTools(modelName, resumedContents, baseConfig, trace, provider);
    } catch (err) {
      logAgentStep(agentTrace, { type: 'error', error: err.message });
      // Retry once on transient error for cream-of-crop reliability
      if (i < maxIterations - 1) {
        await new Promise(r => setTimeout(r, 500));
        try {
          resp = await callGeminiWithTools(modelName, resumedContents, baseConfig, trace, provider);
        } catch (e2) {
          logAgentStep(agentTrace, { type: 'error_retry_failed', error: e2.message });
          agentTrace.status = 'error';
          // Recorded on the task so a paused run explains itself instead of just stopping.
          agentTrace.lastError = e2.message;
          break;
        }
      } else {
        agentTrace.status = 'error';
        agentTrace.lastError = err.message;
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
    const actions = toolCalls.map(tc => ({ type: tc.name, input: tc.args || {}, _toolCallId: tc.id }));

    logAgentStep(agentTrace, { type: 'tool_calls', actions: actions.map(a => a.type) });

    if (onStep) onStep({ phase: 'executing', actions });

    // Execute one model turn's tool calls as an ordered batch so compound
    // requests preserve dependencies and result order.
    let results = [];
    if (typeof executeActionsFn === 'function') {
      try {
        // persistedTaskId travels with the context so a review-gated action can record
        // which run it belongs to. Without it, approving the action later executes it in
        // isolation and the run that asked for it never continues.
        results = await executeActionsFn(userId, actions, {
          ...context,
          agentIteration: i,
          sequential: true,
          persistedTaskId: persistedTask?.id || null,
          taskGoal: persistedTask?.goal || initialMessage
        }, trace);
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
        parts: [{ functionResponse: { id: action._toolCallId, name: action.type || 'unknown', response: { result: resultText } } }]
      });
      lastToolResultsText += `\n[${action.type || 'action'} result]: ${resultText.slice(0, 300)}`;
    });

    // Append model turn that led to tools + the function responses
    resumedContents.push({ role: 'model', parts: responseParts.length ? responseParts : [{ text: spoken || '...' }] });
    resumedContents.push(...functionResponses);

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
      reflectOnResults(initialMessage, actions, results, modelName, provider)
        .then((reflection) => {
          if (!reflection.achieved && reflection.nextAction) {
            logAgentStep(agentTrace, { type: 'reflection', ...reflection });
          }
        })
        .catch(() => {});
    }

    // Written after the actions of this iteration have been executed and recorded, so a
    // crash between iterations resumes at the next one rather than repeating this one.
    await checkpoint(i);

    // A review-gated action parks the run instead of ending it. Burning the remaining
    // iterations here would be worse than useless: the model would re-plan around an action
    // it believes failed, and the approval — when it arrives — would have nothing to
    // continue. The checkpoint above is what the approval resumes from.
    if (results.some((r) => r.result?.pending === true)) {
      logAgentStep(agentTrace, { type: 'awaiting_approval', iteration: i });
      agentTrace.status = 'awaiting_approval';
      break;
    }

    // Safety: if many actions or high risk, may stop early in future
  }

  agentTrace.actionsTaken = executedActions;
  agentTrace.finalSpoken = spoken;
  if (agentTrace.status === 'running') agentTrace.status = 'completed';

  if (persistedTask) {
    try {
      const finished = agentTrace.status === 'completed';
      const awaitingApproval = agentTrace.status === 'awaiting_approval';
      const updates = {
        // A run that stops without completing is 'paused', not left at 'running'. Anything
        // still marked running with a live heartbeat means an instance is working on it,
        // and this one is about to return.
        status: finished ? 'completed' : 'paused',
        results: executedActions,
        plan: agentTrace.plan,
        completed_at: finished ? new Date().toISOString() : null,
        heartbeat_at: null,
        // Waiting on the user is not a failure, so it must not be reported as one.
        last_error: finished || awaitingApproval
          ? null
          : (agentTrace.lastError || 'Run stopped before the goal was complete.'),
        metadata: { ...(persistedTask.metadata || {}), awaitingApproval }
      };
      // Clear the checkpoint only once the goal is done, so a later resume can't replay
      // finished work. An unfinished run keeps its checkpoint — that is what makes it
      // resumable — so the key is omitted rather than set to undefined.
      if (finished) updates.checkpoint = null;
      await taskManager.updateTask(userId, persistedTask.id, updates);
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
async function generatePlan(userId, goal, contextSummary = '', modelName = PRIMARY_CHAT_MODEL, provider = null) {
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

  const resp = await brainProvider.callToolsBrain({
    provider,
    model: modelName,
    contents: [{ role: 'user', parts: [{ text: planPrompt }] }],
    config: { maxOutputTokens: 800 }
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
async function reflectOnResults(goal, actionsTaken, results, modelName = PRIMARY_CHAT_MODEL, provider = null) {
  const summary = `Goal: ${goal}\nActions: ${JSON.stringify(actionsTaken.map(a => a.action))}\nResults summary: ${JSON.stringify(results.map(r => ({a: r.action, ok: r.result?.success !== false})))}`;
  const prompt = `You are the assistant's reflection module. Analyze if the goal was achieved. Output JSON: { "achieved": boolean, "summary": "one sentence", "nextAction" : "null or suggested follow up action type", "issues": [] }`;
  const resp = await brainProvider.callToolsBrain({
    provider,
    model: modelName,
    contents: [{ role: 'user', parts: [{ text: prompt + '\n\n' + summary }] }],
    config: {}
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
  extractToolCalls,
  replacePendingToolResult
};
