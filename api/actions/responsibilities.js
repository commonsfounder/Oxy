'use strict';

// Responsibility actions, lifted out of the switch in api/index.js.

// --- The durable responsibility -------------------------------------------------
// Three thin cases over api/services/workflows.js. The service owns every rule
// (ownership scoping, timeline writes, checkpoint blocking); these only translate.
async function startResponsibility({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase } = deps;
  const goal = String(params?.goal || '').trim();
  if (!goal) return { success: false, error: 'start_responsibility needs the outcome to take on' };
  const wf = require('../services/workflows');
  const workflow = await wf.createWorkflow(supabase, userId, {
    type: String(params?.type || 'general').trim(),
    goal,
    currentStep: params?.current_step || null,
    deadline: params?.deadline || null
  });
  return {
    success: true,
    workflowId: workflow.id,
    text: `I'm on it — ${goal}.`,
    actionSummary: 'Taking that on'
  };
}

async function updateResponsibility({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase } = deps;
  const workflowId = String(params?.workflow_id || '').trim();
  if (!workflowId) return { success: false, error: 'update_responsibility needs which piece of work' };
  const wf = require('../services/workflows');

  // A checkpoint is how work pauses for a human decision, so it takes precedence over
  // any status in the same call — openCheckpoint sets waiting_for_user itself, and
  // letting a status patch land after it would immediately unblock what just blocked.
  if (params?.checkpoint_type && params?.checkpoint_prompt) {
    const checkpoint = await wf.openCheckpoint(supabase, userId, workflowId, {
      type: params.checkpoint_type,
      prompt: String(params.checkpoint_prompt),
      options: params.checkpoint_options || null,
      expiresAt: params.checkpoint_expires_at || null
    });
    return {
      success: true,
      checkpointId: checkpoint.id,
      text: checkpoint.prompt,
      actionSummary: 'Waiting on you'
    };
  }

  const patch = {};
  if (params?.status) patch.status = params.status;
  if (params?.current_step !== undefined) patch.current_step = params.current_step;
  if (params?.next_action !== undefined) patch.next_action = params.next_action;
  const updated = await wf.updateWorkflow(supabase, userId, workflowId, patch, {
    summary: params?.note || null
  });
  return { success: true, text: updated.next_action || updated.current_step || 'Updated.', actionSummary: 'Updated' };
}

async function listResponsibilities({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase } = deps;
  const wf = require('../services/workflows');
  const items = await wf.summarizeForUser(supabase, userId);
  if (!items.length) return { success: true, text: 'No active work.', items: [] };
  const lines = items.map(i => `${i.title}${i.detail ? ` — ${i.detail}` : ''}`);
  return {
    success: true,
    items,
    text: lines.join('\n'),
    actionSummary: `${items.length} on the go`
  };
}

module.exports = {
  handlers: {
    start_responsibility: startResponsibility,
    update_responsibility: updateResponsibility,
    list_responsibilities: listResponsibilities
  }
};
