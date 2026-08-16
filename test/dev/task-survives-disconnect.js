// Live verification (not part of `npm test`): proves a chat-triggered task keeps
// running server-side after the client disconnects mid-turn.
//
//   node test/dev/task-survives-disconnect.js <baseUrl> <sessionToken> <userId>
//
// Get a token from POST /auth/login, or locally from POST /auth/dev/demo-login with
// NODE_ENV=development OXY_ENABLE_DEV_AUTH=true (which also returns the userId).
// /chat takes userId in the body and checks it against the token, so both are needed.
'use strict';

const [, , baseUrl = 'http://localhost:8080', sessionToken, userId] = process.argv;

if (!sessionToken || !userId) {
  console.error('Usage: node test/dev/task-survives-disconnect.js <baseUrl> <sessionToken> <userId>');
  process.exit(1);
}

const authHeaders = { Authorization: `Bearer ${sessionToken}` };

async function main() {
  const controller = new AbortController();
  // Deliberately a monitoring goal, not a transacting one. The behaviour under test is
  // "does a task outlive the client", which any durable goal exercises — so there is no
  // reason to use a goal that could attempt a real booking or payment against a live
  // site. "track" is what trips shouldUseAgenticLoopForMessage's explicitAutonomousGoal.
  const message = 'Keep track of hotel prices in Brighton and let me know when they drop.';

  console.log('[1/3] Sending chat turn, aborting after the first byte...');
  const res = await fetch(`${baseUrl}/chat?stream=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ message, userId }),
    signal: controller.signal
  });

  const reader = res.body.getReader();
  await reader.read(); // first chunk only
  controller.abort();
  console.log('[1/3] Aborted client-side after first chunk.');

  console.log('[2/3] Waiting 20s...');
  await new Promise(r => setTimeout(r, 20000));

  console.log('[3/3] Checking /agent/tasks for a task that kept progressing...');
  const tasksRes = await fetch(`${baseUrl}/agent/tasks`, { headers: authHeaders });
  const { tasks } = await tasksRes.json();
  const brighton = (tasks || []).find(t => /brighton/i.test(t.goal));

  if (!brighton) {
    console.error('FAIL: no task found for the aborted turn — either no task was created, or it did not survive.');
    process.exit(1);
  }
  console.log(`Task found: status=${brighton.status}, currentStep=${brighton.current_step}, updatedAt=${brighton.updated_at}`);
  if (brighton.status === 'pending' && !brighton.current_step) {
    console.error('FAIL: task exists but shows no progress since the abort — likely did not survive disconnect.');
    process.exit(1);
  }
  console.log('PASS: task exists and progressed after client disconnect.');
}

main().catch(err => { console.error(err); process.exit(1); });
