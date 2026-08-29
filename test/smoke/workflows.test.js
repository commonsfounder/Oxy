// The durable responsibility, against the REAL workflows tables and demo-test-user.
//
// The load-bearing test in this file is the last block: four completely different kinds of
// work — a job application, an insurance claim, a trip, a purchase — running through ONE
// primitive. If any of them needed a bespoke table or a special case, the abstraction would
// be wrong and this file is where that shows up.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const { createSupabaseServiceClient } = require('../../runtime');
const {
  createWorkflow, getWorkflow, updateWorkflow, recordEvent, getTimeline,
  openCheckpoint, resolveCheckpoint, getPendingCheckpoints,
  linkToWorkflow, getLinks, saveBrowserState, resumeBrowserState,
  getWorkflowContext, listActiveWorkflows, summarizeForUser
} = require('../../api/services/workflows');

const supabase = createSupabaseServiceClient();
const USER_ID = 'demo-test-user';
const MARK = `WfTest-${process.pid}`;

async function cleanup() {
  const { data } = await supabase.from('workflows').select('id').eq('user_id', USER_ID).ilike('goal', `%${MARK}%`);
  if (data?.length) await supabase.from('workflows').delete().in('id', data.map(w => w.id));
}
test.beforeEach(cleanup);
test.after(cleanup);

const make = (overrides = {}) => createWorkflow(supabase, USER_ID, {
  type: 'job_application', goal: `${MARK} apply for the Software Engineer role`, ...overrides
});

test('a workflow starts as a responsibility, not a task, and its creation is on the timeline', async () => {
  const workflow = await make();
  assert.equal(workflow.status, 'gathering');
  assert.equal(workflow.user_id, USER_ID);

  const timeline = await getTimeline(supabase, USER_ID, workflow.id);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, 'created');
  assert.equal(timeline[0].actor, 'user', 'the user asked for this, Adam did not invent it');
});

test('another user cannot read someone else\'s piece of work', async () => {
  const workflow = await make();
  await assert.rejects(() => getWorkflow(supabase, 'definitely-not-this-user', workflow.id), /not found/i);
});

test('a status change always leaves a trace — state never moves silently', async () => {
  const workflow = await make();
  await updateWorkflow(supabase, USER_ID, workflow.id, { status: 'working', current_step: 'Finding your CV' });

  const timeline = await getTimeline(supabase, USER_ID, workflow.id);
  const change = timeline.find(e => e.kind === 'status_changed');
  assert.ok(change, 'a status change with no timeline entry is how a workflow becomes unexplainable');
  assert.equal(change.detail.from, 'gathering');
  assert.equal(change.detail.to, 'working');
});

test('finishing sets closed_at, and reopening clears it', async () => {
  const workflow = await make();
  const done = await updateWorkflow(supabase, USER_ID, workflow.id, { status: 'completed' });
  assert.ok(done.closed_at);

  const reopened = await updateWorkflow(supabase, USER_ID, workflow.id, { status: 'working' });
  assert.equal(reopened.closed_at, null, 'a reopened workflow must not still count as finished');
});

// ── Checkpoints ────────────────────────────────────────────────────────────────────────

test('opening a checkpoint actually blocks the work', async () => {
  const workflow = await make();
  await updateWorkflow(supabase, USER_ID, workflow.id, { status: 'working' });

  const checkpoint = await openCheckpoint(supabase, USER_ID, workflow.id, {
    type: 'approval', prompt: 'Confirm before I submit this application'
  });
  assert.equal(checkpoint.status, 'pending');

  // A checkpoint that does not visibly stop the work is just a log line.
  const after = await getWorkflow(supabase, USER_ID, workflow.id);
  assert.equal(after.status, 'waiting_for_user');
  assert.equal(after.blocked_reason, 'Confirm before I submit this application');
});

test('approving resumes the work; declining keeps it waiting', async () => {
  const workflow = await make();
  const approve = await openCheckpoint(supabase, USER_ID, workflow.id, { type: 'approval', prompt: 'Submit?' });
  await resolveCheckpoint(supabase, USER_ID, approve.id, { approved: true });
  assert.equal((await getWorkflow(supabase, USER_ID, workflow.id)).status, 'working');

  const decline = await openCheckpoint(supabase, USER_ID, workflow.id, { type: 'approval', prompt: 'Submit now?' });
  await resolveCheckpoint(supabase, USER_ID, decline.id, { approved: false, note: 'wrong salary band' });
  const after = await getWorkflow(supabase, USER_ID, workflow.id);
  assert.equal(after.status, 'waiting_for_user');
});

test('answering one of two open questions does not unblock the work', async () => {
  const workflow = await make();
  const first = await openCheckpoint(supabase, USER_ID, workflow.id, { type: 'approval', prompt: 'Submit?' });
  await openCheckpoint(supabase, USER_ID, workflow.id, { type: 'missing_information', prompt: 'Notice period?' });

  await resolveCheckpoint(supabase, USER_ID, first.id, { approved: true });

  const after = await getWorkflow(supabase, USER_ID, workflow.id);
  assert.equal(after.status, 'waiting_for_user', 'one answer out of two is not an unblock');
  assert.equal((await getPendingCheckpoints(supabase, USER_ID, workflow.id)).length, 1);
});

test('an expired checkpoint cannot be quietly used', async () => {
  const workflow = await make();
  const checkpoint = await openCheckpoint(supabase, USER_ID, workflow.id, {
    type: 'authentication_required',
    prompt: 'Enter the code that just arrived',
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  // A stale MFA code is worthless, and a week-old approval to submit is not an approval.
  await assert.rejects(() => resolveCheckpoint(supabase, USER_ID, checkpoint.id, { approved: true }), /expired/i);
});

test('a checkpoint cannot be answered twice', async () => {
  const workflow = await make();
  const checkpoint = await openCheckpoint(supabase, USER_ID, workflow.id, { type: 'approval', prompt: 'Submit?' });
  await resolveCheckpoint(supabase, USER_ID, checkpoint.id, { approved: true });
  await assert.rejects(() => resolveCheckpoint(supabase, USER_ID, checkpoint.id, { approved: false }), /already/i);
});

test('a choice records which option the user actually picked', async () => {
  const workflow = await make({ type: 'insurance_renewal', goal: `${MARK} sort out the car insurance renewal` });
  const checkpoint = await openCheckpoint(supabase, USER_ID, workflow.id, {
    type: 'choice_required',
    prompt: 'Which quote?',
    options: [{ id: 'a', label: 'Aviva £420, £250 excess' }, { id: 'b', label: 'Direct Line £455, £100 excess' }]
  });
  const resolved = await resolveCheckpoint(supabase, USER_ID, checkpoint.id, {
    approved: true, choice: 'b', note: 'lower excess is worth the £35'
  });
  assert.equal(resolved.resolution_choice, 'b');
  assert.equal(resolved.resolution_note, 'lower excess is worth the £35');
});

// ── Surviving the machinery ────────────────────────────────────────────────────────────

test('a dead browser session does not kill the work — state resumes from the workflow', async () => {
  const workflow = await make();
  await saveBrowserState(supabase, USER_ID, workflow.id, {
    objective: 'Submit the application form',
    currentUrl: 'https://jobs.example/apply/step-3',
    lastObservation: 'Step 3 of 5 — upload your CV',
    completedActions: ['filled name', 'filled email', 'uploaded CV'],
    nextIntendedAction: 'click Continue'
  });

  // Nothing of the session survives; only the workflow does.
  const resumed = await resumeBrowserState(supabase, USER_ID, workflow.id);
  assert.equal(resumed.currentUrl, 'https://jobs.example/apply/step-3');
  assert.equal(resumed.nextIntendedAction, 'click Continue');
  assert.equal(resumed.goal, workflow.goal, 'resuming must carry the objective, not just the URL');
  assert.equal(resumed.completedActions.length, 3);
});

test('browser state stays bounded so a long task cannot grow the row without limit', async () => {
  const workflow = await make();
  const state = await saveBrowserState(supabase, USER_ID, workflow.id, {
    objective: 'long one',
    completedActions: Array.from({ length: 200 }, (_, i) => `action ${i}`)
  });
  assert.equal(state.completedActions.length, 40);
  assert.equal(state.completedActions.at(-1), 'action 199', 'the tail is what resuming needs');
});

test('evidence is a role on a link, not a table of its own', async () => {
  const workflow = await make();
  await linkToWorkflow(supabase, USER_ID, workflow.id, {
    entityType: 'document', entityId: '11111111-1111-1111-1111-111111111111', role: 'evidence'
  });
  const evidence = await getLinks(supabase, USER_ID, workflow.id, { role: 'evidence' });
  assert.equal(evidence.length, 1);
});

test('linking the same thing twice does not duplicate it', async () => {
  const workflow = await make();
  const args = { entityType: 'conversation', entityId: 'conv-abc', role: 'correspondence' };
  await linkToWorkflow(supabase, USER_ID, workflow.id, args);
  await linkToWorkflow(supabase, USER_ID, workflow.id, args);
  assert.equal((await getLinks(supabase, USER_ID, workflow.id)).length, 1);
});

// ── What the user sees ─────────────────────────────────────────────────────────────────

test('the home summary leads with what needs the user, and speaks no jargon', async () => {
  const quiet = await make({ goal: `${MARK} track the AirPods claim`, type: 'claim' });
  await updateWorkflow(supabase, USER_ID, quiet.id, { status: 'waiting_external', current_step: 'Waiting for their response' });

  const noisy = await make({ goal: `${MARK} apply for the engineering role`, type: 'job_application' });
  await openCheckpoint(supabase, USER_ID, noisy.id, { type: 'approval', prompt: 'Needs your CV approval' });

  const summary = (await summarizeForUser(supabase, USER_ID)).filter(i => i.title.includes(MARK));

  assert.equal(summary[0].needsYou, true, 'the only actionable item must not be buried');
  assert.equal(summary[0].detail, 'Needs your CV approval');
  assert.equal(summary.find(i => i.title.includes('AirPods')).detail, 'Waiting for their response');

  // Nothing the user reads may leak the internals.
  const shown = summary.map(i => `${i.title} ${i.detail}`).join(' ').toLowerCase();
  assert.ok(!/workflow|checkpoint|status|entity|waiting_for_user|gathering/.test(shown));
});

test('finished work drops off the active list', async () => {
  const workflow = await make();
  await updateWorkflow(supabase, USER_ID, workflow.id, { status: 'completed' });
  const active = (await listActiveWorkflows(supabase, USER_ID)).filter(w => w.goal.includes(MARK));
  assert.equal(active.length, 0);
});

// ── The abstraction proof ──────────────────────────────────────────────────────────────
// Four unrelated kinds of work through one primitive. No branch on `type` anywhere.

test('a job application, a claim, a trip and a purchase all run on the same primitive', async () => {
  const scenarios = [
    {
      type: 'job_application',
      goal: `${MARK} apply for the Software Engineer role at Acme`,
      step: 'Uploading the tailored CV',
      checkpoint: { type: 'approval', prompt: 'Confirm before I submit this application' },
      evidence: 'submission confirmation'
    },
    {
      type: 'claim',
      goal: `${MARK} sort out the AirPods warranty claim`,
      step: 'Chasing their support team',
      checkpoint: { type: 'missing_information', prompt: 'When did you buy them?' },
      evidence: 'claim reference email'
    },
    {
      type: 'trip',
      goal: `${MARK} get everything sorted for the Lisbon trip`,
      step: 'Comparing flights',
      checkpoint: { type: 'choice_required', prompt: 'Which flight?', options: [{ id: 'am', label: '07:20' }, { id: 'pm', label: '18:45' }] },
      evidence: 'booking confirmation'
    },
    {
      type: 'purchase',
      goal: `${MARK} buy the replacement laptop charger`,
      step: 'At checkout',
      checkpoint: { type: 'payment_confirmation', prompt: 'Approve £62.99' },
      evidence: 'order receipt'
    }
  ];

  for (const scenario of scenarios) {
    const workflow = await createWorkflow(supabase, USER_ID, { type: scenario.type, goal: scenario.goal });
    await updateWorkflow(supabase, USER_ID, workflow.id, { status: 'working', current_step: scenario.step });

    // Same pause primitive for approve / ask / choose / pay.
    const checkpoint = await openCheckpoint(supabase, USER_ID, workflow.id, scenario.checkpoint);
    assert.equal((await getWorkflow(supabase, USER_ID, workflow.id)).status, 'waiting_for_user');

    await resolveCheckpoint(supabase, USER_ID, checkpoint.id, { approved: true, choice: scenario.checkpoint.options?.[0]?.id || null });

    // Same evidence primitive.
    await linkToWorkflow(supabase, USER_ID, workflow.id, {
      entityType: 'document', entityId: `00000000-0000-0000-0000-00000000000${scenarios.indexOf(scenario) + 1}`, role: 'evidence'
    });
    await recordEvent(supabase, workflow.id, { kind: 'evidence_captured', summary: scenario.evidence, actor: 'external' });
    await updateWorkflow(supabase, USER_ID, workflow.id, { status: 'completed' });

    const context = await getWorkflowContext(supabase, USER_ID, workflow.id);
    assert.equal(context.workflow.status, 'completed', `${scenario.type} should complete`);
    assert.equal(context.evidence.length, 1, `${scenario.type} should have evidence`);
    assert.equal(context.pendingCheckpoints.length, 0, `${scenario.type} should have nothing outstanding`);

    // The timeline reads as a story a person could follow.
    const kinds = context.timeline.map(e => e.kind);
    assert.deepEqual(
      kinds,
      ['created', 'status_changed', 'checkpoint_opened', 'checkpoint_resolved', 'evidence_captured', 'status_changed'],
      `${scenario.type} timeline should read the same as every other kind of work`
    );
  }
});

// ── Reachable from a chat turn ─────────────────────────────────────────────────────────
// The primitive being right is not the same as it being usable. These run through the real
// executeAction path, which is how a user sentence actually reaches it.

const app = require('../../api/index');

test('a user handing over an outcome creates a responsibility, and it shows up as one', async () => {
  const started = await app.executeAction(USER_ID, 'start_responsibility', {
    goal: `${MARK} sort out my car insurance renewal`, type: 'insurance_renewal'
  }, {});
  assert.equal(started.success, true);
  assert.ok(started.workflowId);

  const listed = await app.executeAction(USER_ID, 'list_responsibilities', {}, {});
  assert.equal(listed.success, true);
  assert.ok(listed.items.some(i => i.title.includes(MARK)));
  // What the user reads must not leak the machinery.
  assert.ok(!/workflow|status|gathering|uuid/i.test(listed.text));
});

test('pausing for a decision takes precedence over any status in the same call', async () => {
  const started = await app.executeAction(USER_ID, 'start_responsibility', { goal: `${MARK} apply for the role` }, {});

  // A checkpoint and a status in one call: the checkpoint must win, or the status patch
  // would immediately unblock the work that just blocked.
  const paused = await app.executeAction(USER_ID, 'update_responsibility', {
    workflow_id: started.workflowId,
    status: 'working',
    checkpoint_type: 'approval',
    checkpoint_prompt: 'Confirm before I submit this application'
  }, {});
  assert.equal(paused.success, true);
  assert.ok(paused.checkpointId);

  const after = await getWorkflow(supabase, USER_ID, started.workflowId);
  assert.equal(after.status, 'waiting_for_user', 'the status in the same call must not undo the pause');

  const listed = await app.executeAction(USER_ID, 'list_responsibilities', {}, {});
  const item = listed.items.find(i => i.title.includes(MARK) && i.needsYou);
  assert.equal(item.detail, 'Confirm before I submit this application');
});

test('progress recorded through the action lands on the timeline', async () => {
  const started = await app.executeAction(USER_ID, 'start_responsibility', { goal: `${MARK} track the claim` }, {});
  await app.executeAction(USER_ID, 'update_responsibility', {
    workflow_id: started.workflowId, status: 'working', current_step: 'Chasing their support team', note: 'Emailed support'
  }, {});

  const timeline = await getTimeline(supabase, USER_ID, started.workflowId);
  assert.ok(timeline.some(e => e.kind === 'status_changed'));
  const workflow = await getWorkflow(supabase, USER_ID, started.workflowId);
  assert.equal(workflow.current_step, 'Chasing their support team');
});
