'use strict';

// Drives a real responsibility through every lane of the home board, over HTTP, against
// the real database — so "the board works" means the routes the phone calls actually
// returned the right rows, not that a unit test passed with a stubbed client.
//
//   node test/dev/home-board-e2e.js [userId] [baseUrl]
//
// Creates its own workflow and deletes it at the end, so it is safe to run against a live
// account. Nothing it touches belongs to anyone else.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { createSessionToken } = require('../../auth.js');

const USER_ID = process.argv[2] || 'user123';
const BASE = (process.argv[3] || 'http://localhost:8099').replace(/\/$/, '');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const wf = require('../../api/services/workflows.js');

let failures = 0;
function check(label, condition, detail = '') {
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function main() {
  const { data: userRow } = await supabase.from('users')
    .select('token_version').eq('user_id', USER_ID).maybeSingle();
  if (!userRow) throw new Error(`No such user: ${USER_ID}`);
  const token = createSessionToken(USER_ID, userRow.token_version ?? 1);

  const get = async (path) => {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const post = async (path, payload) => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  let workflowId = null;
  try {
    // --- A responsibility begins ------------------------------------------------------
    const workflow = await wf.createWorkflow(supabase, USER_ID, {
      type: 'job_application',
      goal: 'Get the Monzo application submitted',
      currentStep: 'Reading the job description'
    });
    workflowId = workflow.id;
    console.log(`\nworkflow ${workflowId}\n`);

    await wf.updateWorkflow(supabase, USER_ID, workflowId, { status: 'working' },
      { summary: 'Pulled your CV' });
    await wf.recordEvent(supabase, workflowId, {
      kind: 'note', summary: 'Drafted a cover letter tailored to the role', actor: 'millie'
    });

    // --- Handling ---------------------------------------------------------------------
    let state = await get('/agent/state');
    check('GET /agent/state responds 200', state.status === 200, `got ${state.status}`);
    check('the responsibility is in Handling',
      state.body?.handling?.some(i => i.workflowId === workflowId),
      JSON.stringify(state.body?.counts));

    // --- Needs you --------------------------------------------------------------------
    const checkpoint = await wf.openCheckpoint(supabase, USER_ID, workflowId, {
      type: 'choice_required',
      prompt: 'What salary should I put down?',
      options: [
        { id: 'a', label: '£95k', detail: 'The midpoint of the advertised band' },
        { id: 'b', label: '£110k', detail: 'Top of the band' },
        { id: 'c', label: 'Prefer not to say', detail: 'Leave the field blank' }
      ]
    });

    state = await get('/agent/state');
    const blocked = state.body?.needsYou?.find(i => i.workflowId === workflowId);
    check('opening a checkpoint moves it to Needs you', !!blocked);
    check('the question itself is carried', blocked?.prompt === 'What salary should I put down?', blocked?.prompt);
    check('the options are carried', Array.isArray(blocked?.options) && blocked.options.length === 3);
    check('it left Handling', !state.body?.handling?.some(i => i.workflowId === workflowId));

    // --- The timeline screen ----------------------------------------------------------
    const detail = await get(`/workflows/${workflowId}`);
    check('GET /workflows/:id responds 200', detail.status === 200, `got ${detail.status}`);
    check('the timeline has every event',
      (detail.body?.timeline?.length || 0) >= 4,
      `${detail.body?.timeline?.length} events`);
    check('the pending question is on the detail',
      detail.body?.pendingCheckpoints?.some(c => c.id === checkpoint.id),
      `${detail.body?.pendingCheckpoints?.length} pending`);

    // --- Answering from the phone -----------------------------------------------------
    const resolved = await post(`/workflows/${workflowId}/checkpoints/${checkpoint.id}/resolve`,
      { approved: true, choice: '£110k' });
    check('resolving the checkpoint responds 200', resolved.status === 200, `got ${resolved.status}`);
    check('the choice is recorded', resolved.body?.checkpoint?.resolution_choice === '£110k',
      resolved.body?.checkpoint?.resolution_choice);

    state = await get('/agent/state');
    check('answering returns it to Handling',
      state.body?.handling?.some(i => i.workflowId === workflowId),
      JSON.stringify(state.body?.counts));
    check('it left Needs you', !state.body?.needsYou?.some(i => i.workflowId === workflowId));

    // --- Rejecting a bad payload ------------------------------------------------------
    const bad = await post(`/workflows/${workflowId}/checkpoints/${checkpoint.id}/resolve`, {});
    check('a resolve with no decision is rejected', bad.status === 400, `got ${bad.status}`);

    // --- Changed ----------------------------------------------------------------------
    const seenBefore = await post('/agent/state/seen', {});
    check('POST /agent/state/seen responds 200', seenBefore.status === 200, `got ${seenBefore.status}`);

    state = await get('/agent/state');
    check('nothing is Changed immediately after marking seen',
      !state.body?.changed?.some(i => i.workflowId === workflowId),
      `${state.body?.counts?.changed} changed`);

    await wf.recordEvent(supabase, workflowId, {
      kind: 'note', summary: 'Submitted the application', actor: 'millie'
    });
    state = await get('/agent/state');
    check('work done after that shows up in Changed',
      state.body?.changed?.some(i => i.workflowId === workflowId),
      `${state.body?.counts?.changed} changed`);

    // --- Completed --------------------------------------------------------------------
    await wf.updateWorkflow(supabase, USER_ID, workflowId, { status: 'completed' },
      { summary: 'Application submitted' });
    state = await get('/agent/state');
    check('completing it moves it to Completed',
      state.body?.completed?.some(i => i.workflowId === workflowId),
      JSON.stringify(state.body?.counts));
    check('it left Handling for good',
      !state.body?.handling?.some(i => i.workflowId === workflowId));

    // --- Isolation --------------------------------------------------------------------
    const otherToken = createSessionToken('demo-test-user', 1);
    const trespass = await fetch(`${BASE}/workflows/${workflowId}`, {
      headers: { Authorization: `Bearer ${otherToken}` }
    });
    check('another user cannot read it', trespass.status === 404, `got ${trespass.status}`);
  } finally {
    if (workflowId) {
      await supabase.from('workflow_events').delete().eq('workflow_id', workflowId);
      await supabase.from('workflow_checkpoints').delete().eq('workflow_id', workflowId);
      await supabase.from('workflow_links').delete().eq('workflow_id', workflowId);
      await supabase.from('workflows').delete().eq('id', workflowId);
      console.log(`\ncleaned up ${workflowId}`);
    }
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall green');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error('\nERROR:', err.message); process.exit(1); });
