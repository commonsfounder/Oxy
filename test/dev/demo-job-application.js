'use strict';

// Demo 1 — a job application, watched live.
//
//   node test/dev/demo-job-application.js [userId] [--fast]
//
// Opens a real responsibility and walks it through the stages a real application goes
// through, pausing between them so the phone visibly updates: the card appears in
// Handling, the timeline fills in one event at a time, the work stops on a question that
// lands in Needs you, and answering it on the phone lets the rest run to Completed.
//
// Everything here writes through api/services/workflows.js — the same service the chat
// tool path uses. There is no demo mode and no fixture: the rows this creates are the
// rows the product creates.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const USER_ID = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'user123';
const FAST = process.argv.includes('--fast');
const BEAT = FAST ? 400 : 4000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const wf = require('../../api/services/workflows.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`\nStarting an application for ${USER_ID}\n`);

  const workflow = await wf.createWorkflow(supabase, USER_ID, {
    type: 'job_application',
    goal: 'Get the Monzo Staff Engineer application submitted',
    currentStep: 'Reading the job description',
    nextAction: 'Pull the CV and tailor a cover letter',
    deadline: new Date(Date.now() + 3 * 86400000).toISOString()
  });
  console.log(`workflow ${workflow.id}`);
  console.log('  → should now be in HANDLING on the phone\n');
  await wait(BEAT);

  const beats = [
    ['status', 'working', 'Read the job description — 6 requirements, 2 need evidence'],
    ['event', null, 'Found your CV from March, last used for the Wise application'],
    ['event', null, 'Pulled three projects that match what they asked for'],
    ['event', null, 'Drafted a cover letter against their six requirements'],
    ['step', 'Filling in the application form', 'Opened the application form'],
    ['event', null, 'Filled name, email, phone and right-to-work'],
    ['event', null, 'Attached the CV and the cover letter']
  ];

  for (const [kind, value, summary] of beats) {
    if (kind === 'status') {
      await wf.updateWorkflow(supabase, USER_ID, workflow.id, { status: value }, { summary });
    } else if (kind === 'step') {
      await wf.updateWorkflow(supabase, USER_ID, workflow.id, { current_step: value }, { summary });
    } else {
      await wf.recordEvent(supabase, workflow.id, { kind: 'note', summary, actor: 'millie' });
    }
    console.log(`  · ${summary}`);
    await wait(BEAT);
  }

  // The work stops. This is the moment the board is built around: something a person, and
  // only a person, can decide.
  const checkpoint = await wf.openCheckpoint(supabase, USER_ID, workflow.id, {
    type: 'choice_required',
    prompt: 'They ask for salary expectations. What should I put?',
    options: [
      { id: 'mid', label: '£95,000', detail: 'The midpoint of their advertised band' },
      { id: 'top', label: '£110,000', detail: 'Top of the band — matches your last offer' },
      { id: 'skip', label: 'Prefer not to say', detail: 'Leave it blank and discuss later' }
    ]
  });

  console.log(`\ncheckpoint ${checkpoint.id}`);
  console.log('  → the card has moved to NEEDS YOU. Answer it on the phone.\n');

  // Waits for the phone. Nothing here resolves the checkpoint — the whole point is that
  // the answer comes from the user, through the app, over the route the board calls.
  const deadline = Date.now() + 10 * 60 * 1000;
  let answered = null;
  while (Date.now() < deadline) {
    const { data } = await supabase.from('workflow_checkpoints')
      .select('*').eq('id', checkpoint.id).limit(1);
    if (data?.[0]?.status !== 'pending') { answered = data[0]; break; }
    await wait(2000);
  }

  if (!answered) {
    console.log('No answer within 10 minutes — leaving it open.');
    console.log(`workflow ${workflow.id}`);
    process.exit(0);
  }

  console.log(`answered: ${answered.resolution_choice || answered.status}\n`);
  await wait(BEAT);

  if (answered.status === 'rejected') {
    await wf.updateWorkflow(supabase, USER_ID, workflow.id, { status: 'cancelled' },
      { summary: 'Left it for you to finish' });
    console.log('Stopped, as asked.');
    process.exit(0);
  }

  const finish = [
    `Put ${answered.resolution_choice || 'their band'} in the salary field`,
    'Checked the whole form against the job description',
    'Submitted the application',
    'Confirmation received — reference MZ-4471'
  ];
  for (const summary of finish) {
    await wf.recordEvent(supabase, workflow.id, { kind: 'note', summary, actor: 'millie' });
    console.log(`  · ${summary}`);
    await wait(BEAT);
  }

  await wf.updateWorkflow(supabase, USER_ID, workflow.id, { status: 'completed' },
    { summary: 'Application submitted' });
  console.log('\n  → should now be in COMPLETED on the phone');
  console.log(`\nworkflow ${workflow.id}`);
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
