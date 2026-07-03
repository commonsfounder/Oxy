// Agent orchestrator - no circular deps. Client and model injected or required carefully.
let modernGenAI;
let PRIMARY_CHAT_MODEL = 'gemini-3-flash-preview';

try {
  const { ModernGoogleGenAI } = require('@google/genai');
  modernGenAI = new ModernGoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
  PRIMARY_CHAT_MODEL = process.env.OXY_REASONING_MODEL || process.env.GEMINI_MODEL || PRIMARY_CHAT_MODEL;
} catch (e) {
  console.warn('[agent-orchestrator] Gemini client init warning:', e.message);
}

const { buildToolsForGemini } = require('../action-contracts');
const taskManager = require('./task-manager');

// Simple in-memory for traces during a run; production should persist
const runTraces = new Map();

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

  // Cream-of-the-crop: auto plan for complex goals
  if (initialMessage.length > 50 || /plan|book|research|find|organize|handle|arrange/i.test(initialMessage)) {
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
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
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
          break;
        }
      } else {
        break;
      }
    }

    const toolCalls = [];
    // Extract function calls robustly
    const parts = resp?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p.functionCall) {
        toolCalls.push({ name: p.functionCall.name, args: p.functionCall.args || {} });
      }
    }
    if (resp?.functionCalls) {
      resp.functionCalls.forEach(fc => toolCalls.push({ name: fc.name, args: fc.args || {} }));
    }

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

    // Execute in parallel where safe (cream-of-crop agents do this for speed)
    let results = [];
    if (typeof executeActionsFn === 'function') {
      // Run actions in parallel for independent tools
      results = await Promise.all(actions.map(async (a) => {
        try {
          const res = await executeActionsFn(userId, [a], { ...context, agentIteration: i }, trace);
          return res[0] || { action: a.type, result: { success: true } };
        } catch (e) {
          return { action: a.type, result: { success: false, error: e.message } };
        }
      }));
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
    contents.push({ role: 'model', parts: parts.length ? parts : [{ text: spoken || '...' }] });
    contents.push(...functionResponses);

    logAgentStep(agentTrace, { type: 'observe', results: results.map(r => r.action) });

    if (onStep) onStep({ phase: 'observed', results });

    // Cream-of-the-crop: mid-loop reflection for self-correction
    if (i > 0 && results.length > 0) {
      try {
        const reflection = await reflectOnResults(initialMessage, actions, results);
        if (!reflection.achieved && reflection.nextAction) {
          logAgentStep(agentTrace, { type: 'reflection', ...reflection });
          // Continue to next iteration with correction
        }
      } catch {}
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

  return {
    spoken: spoken || lastToolResultsText || 'Done.',
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
  const prompt = `You are Oxy's reflection module. Analyze if the goal was achieved. Output JSON: { "achieved": boolean, "summary": "one sentence", "nextAction" : "null or suggested follow up action type", "issues": [] }`;
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
  delegateToSpecialist
};
