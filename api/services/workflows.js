'use strict';

// The durable responsibility.
//
// A task is an action ("upload the CV"). A workflow is the responsibility ("get this
// application submitted"). This module owns the second thing, and deliberately does not
// reimplement the first — agent_tasks still does tasks, and now carries a workflow_id.
//
// Everything here is built so that the responsibility outlives its machinery. A browser
// session ending, a day passing, waiting on the user, waiting on a company, or switching
// from the browser to email entirely must none of them lose the thread. That is why
// browser state is a JSON column describing where we got to, and never a live handle.
//
// There is one workflow shape for every kind of work. A job application, an insurance
// claim, a trip and a purchase are all goal + documents + correspondence + checkpoints +
// deadline + evidence. `type` is a label for presentation, never a branch — if a new kind
// of work needed a new table, the abstraction would be wrong.

const ACTIVE_STATUSES = ['gathering', 'working', 'waiting_for_user', 'waiting_external'];
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

// A pending checkpoint means work has stopped and a human decision is required. These are
// the statuses that say so, used to derive what the user sees on the home screen.
const BLOCKED_STATUSES = ['waiting_for_user'];

async function createWorkflow(supabase, userId, { type, goal, currentStep = null, nextAction = null, deadline = null } = {}) {
  if (!type || !goal) throw new Error('A workflow needs a type and a goal.');
  const { data, error } = await supabase.from('workflows').insert({
    user_id: userId, type, goal, status: 'gathering',
    current_step: currentStep, next_action: nextAction, deadline
  }).select().single();
  if (error) throw new Error(`Couldn't start that piece of work: ${error.message}`);

  await recordEvent(supabase, data.id, { kind: 'created', summary: goal, actor: 'user' });
  return data;
}

async function getWorkflow(supabase, userId, workflowId) {
  const { data } = await supabase.from('workflows').select('*')
    .eq('id', workflowId).eq('user_id', userId).limit(1);
  const workflow = data?.[0] || null;
  if (!workflow) throw new Error('That piece of work was not found.');
  return workflow;
}

// Every mutation goes through here so `updated_at` and `closed_at` cannot drift, and so a
// status change always leaves a trace on the timeline rather than silently happening.
async function updateWorkflow(supabase, userId, workflowId, patch = {}, { summary = null, actor = 'millie' } = {}) {
  const before = await getWorkflow(supabase, userId, workflowId);
  const next = { ...patch, updated_at: new Date().toISOString() };

  if (patch.status && TERMINAL_STATUSES.includes(patch.status) && !before.closed_at) {
    next.closed_at = new Date().toISOString();
  }
  // Reopening: a workflow that comes back to life must not keep a closed_at, or "what did
  // Millie finish" starts counting things that are still running.
  if (patch.status && ACTIVE_STATUSES.includes(patch.status) && before.closed_at) {
    next.closed_at = null;
  }

  const { data, error } = await supabase.from('workflows').update(next).eq('id', workflowId).select().single();
  if (error) throw new Error(`Couldn't update that piece of work: ${error.message}`);

  if (patch.status && patch.status !== before.status) {
    await recordEvent(supabase, workflowId, {
      kind: 'status_changed',
      summary: summary || `${before.status} → ${patch.status}`,
      actor,
      detail: { from: before.status, to: patch.status }
    });
  } else if (summary) {
    await recordEvent(supabase, workflowId, { kind: 'note', summary, actor });
  }
  return data;
}

// --- Timeline ---------------------------------------------------------------------------

async function recordEvent(supabase, workflowId, { kind, summary, actor = 'millie', refType = null, refId = null, detail = null } = {}) {
  const { data, error } = await supabase.from('workflow_events').insert({
    workflow_id: workflowId, kind, summary, actor,
    ref_type: refType, ref_id: refId, detail
  }).select().single();
  if (error) throw new Error(`Couldn't record that: ${error.message}`);
  return data;
}

async function getTimeline(supabase, userId, workflowId) {
  await getWorkflow(supabase, userId, workflowId);
  const { data } = await supabase.from('workflow_events').select('*')
    .eq('workflow_id', workflowId).order('created_at', { ascending: true });
  return data || [];
}

// --- Checkpoints ------------------------------------------------------------------------
// One primitive for every kind of stop. Opening one moves the workflow to waiting_for_user,
// because a checkpoint that does not visibly block the work is just a log line.

async function openCheckpoint(supabase, userId, workflowId, { type, prompt, options = null, expiresAt = null } = {}) {
  await getWorkflow(supabase, userId, workflowId);
  if (!type || !prompt) throw new Error('A checkpoint needs a type and something to ask.');

  const { data, error } = await supabase.from('workflow_checkpoints').insert({
    workflow_id: workflowId, type, prompt, options, expires_at: expiresAt, status: 'pending'
  }).select().single();
  if (error) throw new Error(`Couldn't pause for that: ${error.message}`);

  await recordEvent(supabase, workflowId, {
    kind: 'checkpoint_opened', summary: prompt, actor: 'millie', refType: 'checkpoint', refId: data.id
  });
  await supabase.from('workflows').update({
    status: 'waiting_for_user',
    blocked_reason: prompt,
    next_action: prompt,
    updated_at: new Date().toISOString()
  }).eq('id', workflowId);

  return data;
}

async function resolveCheckpoint(supabase, userId, checkpointId, { approved, choice = null, note = null } = {}) {
  const { data: rows } = await supabase.from('workflow_checkpoints').select('*').eq('id', checkpointId).limit(1);
  const checkpoint = rows?.[0];
  if (!checkpoint) throw new Error('That decision was not found.');
  await getWorkflow(supabase, userId, checkpoint.workflow_id); // ownership check

  if (checkpoint.status !== 'pending') {
    throw new Error(`That decision was already ${checkpoint.status}.`);
  }
  // An expired checkpoint must not be quietly usable: an MFA code is worthless minutes
  // later, and a stale approval to submit is not an approval.
  if (checkpoint.expires_at && new Date(checkpoint.expires_at).getTime() < Date.now()) {
    await supabase.from('workflow_checkpoints').update({ status: 'expired' }).eq('id', checkpointId);
    throw new Error('That decision expired — ask me again and I\'ll re-check.');
  }

  const status = approved ? 'approved' : 'rejected';
  const { data, error } = await supabase.from('workflow_checkpoints').update({
    status, resolution_choice: choice, resolution_note: note, resolved_at: new Date().toISOString()
  }).eq('id', checkpointId).select().single();
  if (error) throw new Error(`Couldn't record that decision: ${error.message}`);

  await recordEvent(supabase, checkpoint.workflow_id, {
    kind: 'checkpoint_resolved',
    summary: approved ? `Approved: ${checkpoint.prompt}` : `Declined: ${checkpoint.prompt}`,
    actor: 'user', refType: 'checkpoint', refId: checkpointId,
    detail: { choice, note }
  });

  // Only unblock if nothing ELSE is still pending — two open questions and one answer means
  // the work is still waiting.
  const stillPending = await getPendingCheckpoints(supabase, userId, checkpoint.workflow_id);
  if (!stillPending.length) {
    await supabase.from('workflows').update({
      status: approved ? 'working' : 'waiting_for_user',
      blocked_reason: approved ? null : 'you declined — tell me what to do instead',
      updated_at: new Date().toISOString()
    }).eq('id', checkpoint.workflow_id);
  }
  return data;
}

async function getPendingCheckpoints(supabase, userId, workflowId) {
  await getWorkflow(supabase, userId, workflowId);
  const { data } = await supabase.from('workflow_checkpoints').select('*')
    .eq('workflow_id', workflowId).eq('status', 'pending');
  return data || [];
}

// --- Links ------------------------------------------------------------------------------
// Evidence is a role, not a table: a submission confirmation is a document linked with
// role 'evidence'.

async function linkToWorkflow(supabase, userId, workflowId, { entityType, entityId, role = 'related' } = {}) {
  await getWorkflow(supabase, userId, workflowId);
  const { data, error } = await supabase.from('workflow_links')
    .upsert({ workflow_id: workflowId, entity_type: entityType, entity_id: String(entityId), role },
      { onConflict: 'workflow_id,entity_type,entity_id,role' })
    .select().single();
  if (error) throw new Error(`Couldn't attach that: ${error.message}`);
  return data;
}

async function getLinks(supabase, userId, workflowId, { entityType = null, role = null } = {}) {
  await getWorkflow(supabase, userId, workflowId);
  let q = supabase.from('workflow_links').select('*').eq('workflow_id', workflowId);
  if (entityType) q = q.eq('entity_type', entityType);
  if (role) q = q.eq('role', role);
  const { data } = await q;
  return data || [];
}

// --- Browser state ----------------------------------------------------------------------
// The durable thing is the objective and where we got to, never a tab. A session that dies
// is reconstructed by reopening currentUrl and reading this back.

async function saveBrowserState(supabase, userId, workflowId, {
  objective, currentUrl = null, lastObservation = null, completedActions = [], nextIntendedAction = null
} = {}) {
  await getWorkflow(supabase, userId, workflowId);
  const state = {
    objective,
    currentUrl,
    lastObservation,
    // Bounded: a long task would otherwise grow this column without limit, and the
    // timeline is the real history. The tail is what resuming needs.
    completedActions: (completedActions || []).slice(-40),
    nextIntendedAction,
    savedAt: new Date().toISOString()
  };
  const { data, error } = await supabase.from('workflows')
    .update({ browser_state: state, updated_at: new Date().toISOString() })
    .eq('id', workflowId).select().single();
  if (error) throw new Error(`Couldn't save where I got to: ${error.message}`);
  return data.browser_state;
}

async function resumeBrowserState(supabase, userId, workflowId) {
  const workflow = await getWorkflow(supabase, userId, workflowId);
  if (!workflow.browser_state) return null;
  return { ...workflow.browser_state, goal: workflow.goal, workflowId };
}

// --- The whole picture ------------------------------------------------------------------

// Everything a workflow touches, in one read — what the agent needs to pick a responsibility
// back up cold, days later.
async function getWorkflowContext(supabase, userId, workflowId) {
  const workflow = await getWorkflow(supabase, userId, workflowId);
  const [timeline, checkpoints, links, documents] = await Promise.all([
    getTimeline(supabase, userId, workflowId),
    getPendingCheckpoints(supabase, userId, workflowId),
    getLinks(supabase, userId, workflowId),
    supabase.from('documents').select('*').eq('workflow_id', workflowId).then(r => r.data || [])
  ]);
  return {
    workflow,
    timeline,
    pendingCheckpoints: checkpoints,
    links,
    documents,
    evidence: links.filter(l => l.role === 'evidence')
  };
}

async function listActiveWorkflows(supabase, userId) {
  const { data } = await supabase.from('workflows').select('*')
    .eq('user_id', userId).order('updated_at', { ascending: false });
  return (data || []).filter(w => ACTIVE_STATUSES.includes(w.status));
}

// What the home screen renders. Deliberately produces no jargon: the user is never shown the
// word "workflow", a status enum, or an id — they see what Millie is handling and what, if
// anything, she needs. AGENTS.md editing rule 6: terse and factual, or absent.
async function summarizeForUser(supabase, userId) {
  const active = await listActiveWorkflows(supabase, userId);
  const items = [];
  for (const workflow of active) {
    const pending = await getPendingCheckpoints(supabase, userId, workflow.id);
    const needsYou = pending.length > 0 || BLOCKED_STATUSES.includes(workflow.status);
    items.push({
      id: workflow.id,
      title: workflow.goal,
      // One line under the title. The pending question wins when there is one, because it
      // is the only line that asks the user for anything.
      detail: pending[0]?.prompt || workflow.next_action || workflow.current_step || '',
      needsYou,
      deadline: workflow.deadline
    });
  }
  // Anything waiting on the user floats up — that is the only part of this list they can act
  // on, and burying it under things that are merely in progress makes the list decorative.
  return items.sort((a, b) => (b.needsYou ? 1 : 0) - (a.needsYou ? 1 : 0));
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  recordEvent,
  getTimeline,
  openCheckpoint,
  resolveCheckpoint,
  getPendingCheckpoints,
  linkToWorkflow,
  getLinks,
  saveBrowserState,
  resumeBrowserState,
  getWorkflowContext,
  listActiveWorkflows,
  summarizeForUser
};
