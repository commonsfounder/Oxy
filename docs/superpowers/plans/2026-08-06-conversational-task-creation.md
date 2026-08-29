# Conversational Task Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the client-side heuristic that forks a user's first message into two different screens (chat vs. a job-wizard sheet) before any conversation happens, confirm the backend's existing mid-conversation task-persistence already covers what that fork was trying to do, and add a direct approve/deny action to Home's task cards alongside (not instead of) natural-language approval in chat.

**Architecture:** No new subsystem. This plan removes one client-side classifier (`AgentPlanGenerator.jobKind`) so all composer input goes through the one existing conversational surface (`ChatView`), relies on backend logic that already persists a durable `agent_tasks` row from any chat turn (`persistTask: true` in `runAgenticLoop`), and adds one new REST endpoint (`POST /agent/tasks/:id/approval`) that is a thin reuse of approval-resolution functions that already exist and are already exercised by `/chat`'s natural-language confirm/cancel path.

**Tech Stack:** Swift/SwiftUI (OxyApp, iOS), Node.js/Express (api/index.js), Supabase (agent_runtime_approvals, agent_tasks), `node --test` for backend tests, `xcodebuild` for iOS build verification (this repo has no iOS unit test target — see Global Constraints).

## Global Constraints

- Do not create a second "mode" for delegation. Talking to Adam stays one surface; whether a task spins up is decided per-turn, not by which screen the user is looking at.
- Do not promote `AgentWorkView` or `TrustCenterView` to top-level navigation in this pass — that is explicitly deferred pending a separate consumer-product review.
- Do not redesign or touch `AgentTaskSessionView`'s generated step UI in this pass — its only involvement here is that its one calling path (the `jobKind` fork) is being removed.
- `npm test` must stay green before any commit — no exceptions (AGENTS.md).
- This repo has no iOS unit test target (verified: no `*Tests` directory exists anywhere in the tree). iOS verification is `xcodebuild build` for compile-correctness plus manual/simulator verification of the actual behavior change, per AGENTS.md's existing verification standard ("trust xcodebuild output... exercising the real flow beats unit tests alone").
- Never `git add -A` / `git add .` — stage explicit paths only (AGENTS.md, this user has live uncommitted Xcode work routinely).
- Work directly on `main`, commit per task, do not push unless asked (push = deploy per AGENTS.md).
- Approve/deny actions added to Home cards are **additive** to chat's existing natural-language approval resolution, not a replacement for it.

---

## File Structure

| File | Responsibility |
|---|---|
| `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift` | Modify: remove the `jobKind` fork in `handleIntent`; add approve/deny handlers and wire them into `MissionCardView`; stop hard-coding "Paused" for an awaiting-approval task. |
| `OxyApp/OxyApp/Models/AgentTaskSession.swift` | Modify: delete the now-unused `AgentPlanGenerator` enum (its one caller is removed in the file above). `AgentJobKind`, `AgentTaskSession`, and everything else in this file is untouched — the mail-CTA path (`AgenticHomeView.swift:810`) still constructs `AgentTaskSession` directly and must keep working. |
| `OxyApp/OxyApp/Views/Home/GlebAgenticFlow.swift` | Modify: one stale doc comment that describes the pipeline as `AgentPlanGenerator → AgentTaskSession`, which stops being true. |
| `OxyApp/OxyApp/Services/AgentTasksService.swift` | Modify: add `resolveApproval(id:decision:)`. |
| `api/index.js` | Modify: add `getPendingApprovalForTask(userId, taskId)` helper near the existing `getPendingAction`; add `POST /agent/tasks/:id/approval` route near the existing `/agent/tasks/:id/run` route; export the new helper for testing. |
| `test/smoke/agent-tasks-approval-route.test.js` | Create: unit tests for `getPendingApprovalForTask` and the approve/deny outcomes it enables, following this repo's existing fake-supabase test pattern (see `test/smoke/agent-approval-runtime.test.js`). |
| `test/dev/task-survives-disconnect.js` | Create: a live verification script (not part of `npm test`) that proves a chat-triggered task keeps running after the client disconnects — mirrors the existing `test/dev/*-e2e.js` convention used for real-flow verification elsewhere in this repo. |

No new files for Task 1 (iOS fork removal) — it is a deletion plus one small behavior change in an existing file.

---

### Task 1: Remove the client-side `jobKind` fork (covers user's steps 1 and 2)

**Files:**
- Modify: `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift:868-887` (the `handleIntent` function)
- Modify: `OxyApp/OxyApp/Models/AgentTaskSession.swift:504-539` (delete `AgentPlanGenerator`)
- Modify: `OxyApp/OxyApp/Views/Home/GlebAgenticFlow.swift:114-121` (stale comment)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. `handleIntent(_ text: String)` keeps its existing signature and all existing call sites (`sendComposer()`, `suggestionRail` buttons, `handleLifeBriefingItem`, `handleMailCTA`'s `.reply`/fallback branches) are unaffected — they all just call `handleIntent(text)` and now always land in chat instead of sometimes landing in a different screen.

**Behavior before:**
`handleIntent` runs a keyword classifier (`AgentPlanGenerator.jobKind`, matching against `"buy"`, `"order me a"`, `"uber"`, food/delivery words, etc.) on the raw composer text *before* any conversation happens. A match opens `AgentTaskSessionView` (a step-wizard sheet); anything else opens `ChatView`. Two materially different screens for what looks to the user like "typing something into the same box." A phrase like "Find me somewhere in Brighton under £100 and book the best option" and a phrase like "I've been thinking about going to Brighton this weekend" can land the user in two different UIs depending on wording, with no way for the first (small talk) to evolve into the second (delegated work) without leaving the thread.

**Behavior after:**
Every composer submission opens the same `ChatView`. Whether a durable task gets created is decided turn-by-turn by the backend's existing agentic-loop logic inside `/chat` (unchanged — see Task verification note below), which already persists a task (`persistTask: true`) when it decides a turn warrants one. This is user step 2 ("route composer input into the same conversational flow and allow the existing backend to start persistent work naturally") — it requires no backend change because the backend already does this; it only requires removing the client-side pre-emption.

- [ ] **Step 1: Confirm there is exactly one other caller of `AgentTaskSession(...)` besides the one being removed**

```bash
grep -rn "AgentTaskSession(\|AgentPlanGenerator" --include="*.swift" OxyApp | grep -v build/
```

Expected output (matches what was found during audit):
```
OxyApp/Models/AgentTaskSession.swift:508:enum AgentPlanGenerator {
OxyApp/Models/AgentTaskSession.swift:515:    static func jobKind(for prompt: String) -> AgentJobKind? {
OxyApp/Views/Home/AgenticHomeView.swift:810:        startSession(AgentTaskSession(
OxyApp/Views/Home/AgenticHomeView.swift:870:        if let kind = AgentPlanGenerator.jobKind(for: text) {
OxyApp/Views/Home/AgenticHomeView.swift:871:        startSession(AgentTaskSession(
OxyApp/Views/Home/GlebAgenticFlow.swift:120:// AgentPlanGenerator → AgentTaskSession.
```

If the line 810 call site (the mail-CTA "handle it" button, an explicit tap with a known `kind: .task` and `emailAction`, not a text classification) has moved or gained new callers since the audit, stop and re-scope this task — it must be left working exactly as-is.

- [ ] **Step 2: Replace `handleIntent`**

In `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift`, replace:

```swift
    private func handleIntent(_ text: String) {
        HapticManager.shared.impact(.medium)
        if let kind = AgentPlanGenerator.jobKind(for: text) {
            startSession(AgentTaskSession(
                title: text,
                originalPrompt: text,
                kind: kind,
                userId: appState.userId,
                chatService: service,
                location: LocationManager.shared.locationDict
            ))
        } else {
            openChat(autoSend: text, startFresh: true)
        }
    }
```

with:

```swift
    private func handleIntent(_ text: String) {
        HapticManager.shared.impact(.medium)
        openChat(autoSend: text, startFresh: true)
    }
```

- [ ] **Step 3: Delete the now-dead classifier**

In `OxyApp/OxyApp/Models/AgentTaskSession.swift`, delete lines 504-539 in full (the `// MARK: - Intent match...` comment block and the entire `enum AgentPlanGenerator { ... }` body, through its closing brace). Do **not** touch `enum AgentJobKind` (lines 35-39) — it is still used by `AgentTaskSession`'s own stored `kind` property and by the mail-CTA call site's explicit `kind: .task`.

- [ ] **Step 4: Fix the stale doc comment**

In `OxyApp/OxyApp/Views/Home/GlebAgenticFlow.swift`, the comment block around line 114-121 currently reads:

```swift
// MARK: - Gleb visual chrome (shared)
//
// Visual language after the Gleb Kuznetsov concept: soft pastel mesh wash, glass,
// muted ink. These are the reusable pieces that skin the real agentic surfaces
// (AgenticHomeView + AgentTaskSessionView). There is deliberately no scripted flow
// here — the multi-step UI is generated from the user's own intent by
// AgentPlanGenerator → AgentTaskSession.
```

Replace the last two lines with:

```swift
// here — the multi-step UI is generated by AgentTaskSession, constructed directly
// wherever a specific action already knows its shape (e.g. the inbox "handle it" CTA).
```

- [ ] **Step 5: Build**

```bash
xcodebuild -project OxyApp/OxyApp.xcodeproj -scheme OxyApp -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16' build 2>&1 | tail -40
```

Expected: `** BUILD SUCCEEDED **`. If it fails on an unresolved `AgentPlanGenerator`/`jobKind` reference, Step 1's grep missed a call site — find and resolve it before continuing (do not silently re-add a fork elsewhere).

- [ ] **Step 6: Manual verification in the simulator**

Using the `run` skill / iOS Simulator tool: launch the app, and from Home's composer send, in the same conversation:
1. "I've been thinking about going to Brighton this weekend." — expect a normal conversational reply, no task created.
2. Follow up in the same thread with "Could you find somewhere nice for us to stay?" — expect the assistant to act (not just talk) and expect the new task to be visible on Home after dismissing chat (this exercises Task 3 below at the same time).
3. Separately, from a fresh Home composer send: "Order me a takeaway" and "Uber home" — confirm both now open the same `ChatView` (previously these matched `AgentPlanGenerator`'s food/ride keywords and would have opened the wizard sheet) and still result in real work happening (an order gets placed / a ride gets booked) via chat's own action-execution path, not via the now-removed wizard.

- [ ] **Step 7: Commit**

```bash
git add OxyApp/OxyApp/Views/Home/AgenticHomeView.swift OxyApp/OxyApp/Models/AgentTaskSession.swift OxyApp/OxyApp/Views/Home/GlebAgenticFlow.swift
git commit -m "$(cat <<'EOF'
feat(ios): remove client-side jobKind fork, route all composer input through chat

Talking to Adam was silently forking into two different screens (chat vs. an
AgentTaskSession wizard) based on a keyword match on the first message, before
any conversation happened. The backend already decides per-turn whether to
persist a durable task from a chat message, so the client-side pre-classification
was redundant and produced an inconsistent experience for equivalent requests.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Verify task survival across disconnect (user's step 3)

This task produces no required production code change — it is a verification pass, plus one new live-verification script kept for future regressions. A real risk was found during research; read the note before running the verification.

**Files:**
- Create: `test/dev/task-survives-disconnect.js` (live script, not part of `npm test` — mirrors the existing convention of `test/dev/jl-order-e2e.js` and `test/dev/browser-task-e2e.js`, which are real-flow scripts run manually against a live deployment, not CI-gated unit tests).

**Interfaces:**
- Consumes: the live `/chat` endpoint (`POST {baseUrl}/chat`) and `GET {baseUrl}/agent/tasks`, both already deployed and unchanged by this plan.
- Produces: nothing consumed by later tasks — this is a standalone verification artifact.

**Risk found during research (read before running verification):**

The live Cloud Run service is configured with:
```
timeoutSeconds: 300
autoscaling.knative.dev/minScale: '1'
autoscaling.knative.dev/maxScale: '1'
```
(confirmed via `gcloud run services describe oxy --region=europe-west2`, no `run.googleapis.com/cpu-throttling: 'false'` annotation present, meaning CPU-always-allocated is **not** enabled).

What this means concretely:
- When a task is created and driven from a **live chat turn**, `/chat` calls `await runAgenticLoop(...)` and only responds once it resolves ([api/index.js:7995-8034](api/index.js:7995)). Because the request is still "in flight" from Cloud Run's point of view for that whole duration, the run is **not** at risk from CPU throttling — but it **is** capped by the platform's 300-second request timeout. A chat-triggered task whose first turn takes longer than 5 minutes (plausible for a real multi-site "find and book" browser-automation goal) will be killed by the platform itself, independent of whether the user is still in the conversation. This is a pre-existing limit, not something this plan introduces, but this plan is what makes chat the *default and only* on-ramp for this kind of request, so it is now more likely to be hit.
- Once a task is durable (has a `checkpoint`/is `paused`/`awaitingApproval`) and gets resumed via `POST /agent/tasks/:id/run`, that path *is* genuinely fire-and-forget (`runAgenticLoop(...).then(...)` without awaiting before `res.json`, [api/index.js:9394-9437](api/index.js:9394)) — and *that* path's continued execution after the response has been sent does depend on the instance's CPU not being throttled to near-zero. With `minScale: 1` and `containerConcurrency: 80`, the single always-on instance is likely to have other concurrent requests keeping it CPU-active most of the time, but this is probabilistic, not guaranteed.

This plan does not change either of these facts — it only makes the first (chat-turn-triggered) path the primary way tasks get created. Flagging both numbers so the verification below actually tests the real ceiling, and so a decision to raise the Cloud Run timeout (a `gcloud run services update --timeout=900` -style change) can be made deliberately later rather than discovered as a mystery bug. Not doing this now — it's an infra/deploy change outside this plan's four approved steps.

- [ ] **Step 1: Write the live verification script**

Create `test/dev/task-survives-disconnect.js`:

```javascript
// Live verification (not part of `npm test`): proves a chat-triggered task keeps
// running server-side after the client disconnects mid-turn. Run manually against
// a real deployment: node test/dev/task-survives-disconnect.js <baseUrl> <sessionCookie>
'use strict';

const [, , baseUrl = 'http://localhost:8080', sessionCookie] = process.argv;

if (!sessionCookie) {
  console.error('Usage: node test/dev/task-survives-disconnect.js <baseUrl> <sessionCookie>');
  process.exit(1);
}

async function main() {
  const controller = new AbortController();
  const message = 'Find a hotel in Brighton under £100 for this weekend and book the best option.';

  console.log('[1/3] Sending chat turn, aborting after the first byte...');
  const chatPromise = fetch(`${baseUrl}/chat?stream=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({ message }),
    signal: controller.signal
  });

  const res = await chatPromise;
  const reader = res.body.getReader();
  await reader.read(); // first chunk only
  controller.abort();
  console.log('[1/3] Aborted client-side after first chunk.');

  console.log('[2/3] Waiting 20s...');
  await new Promise(r => setTimeout(r, 20000));

  console.log('[3/3] Checking /agent/tasks for a task that kept progressing...');
  const tasksRes = await fetch(`${baseUrl}/agent/tasks`, { headers: { Cookie: sessionCookie } });
  const { tasks } = await tasksRes.json();
  const brighton = tasks.find(t => /brighton/i.test(t.goal));

  if (!brighton) {
    console.error('FAIL: no task found for the aborted turn — either no task was created, or it did not survive.');
    process.exit(1);
  }
  console.log(`Task found: status=${brighton.status}, currentStep=${brighton.currentStep}, updatedAt=${brighton.updatedAt}`);
  if (brighton.status === 'pending' && brighton.currentStep === 0) {
    console.error('FAIL: task exists but shows no progress since the abort — likely did not survive disconnect.');
    process.exit(1);
  }
  console.log('PASS: task exists and progressed after client disconnect.');
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it against the live deployment**

Get a real session cookie by logging in through the app or `POST /login` first, then:

```bash
node test/dev/task-survives-disconnect.js https://<live-cloud-run-url> "<session-cookie-header-value>"
```

Expected: `PASS: task exists and progressed after client disconnect.` If it fails, do not proceed to treat step 3 as confirmed — report the failure mode (no task created at all vs. task created but frozen) before continuing to Task 3's UI work, since Task 3 assumes tasks reliably outlive the conversation.

- [ ] **Step 3: Commit the verification script (not gated in CI, kept for future regressions)**

```bash
git add test/dev/task-survives-disconnect.js
git commit -m "$(cat <<'EOF'
test(agent): add live verification that chat-triggered tasks survive disconnect

Confirms the pattern conversational task creation now depends on: a task
created inside a live /chat turn keeps running server-side after the client
aborts. Not CI-gated (matches test/dev/*-e2e.js convention) since it needs a
live deployment and a real session.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add direct approval actions to Home cards (user's step 4)

**Files:**
- Modify: `api/index.js` — add `getPendingApprovalForTask` (near `getPendingAction`, ~line 3975) and `POST /agent/tasks/:id/approval` (near `POST /agent/tasks/:id/run`, after line 9438); add one new export.
- Modify: `OxyApp/OxyApp/Services/AgentTasksService.swift` — add `resolveApproval(id:decision:)`.
- Modify: `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift` — `HomeMission` gets an `awaitingApproval` field; `persistentTaskMissions` sets it; `MissionCardView` gets an `approvalCard` branch with independent Approve/Deny buttons; `AgenticHomeView` gets `approveTask`/`denyTask` handlers.
- Create: `test/smoke/agent-tasks-approval-route.test.js`.

**Interfaces:**
- Consumes: `agentApprovals.listPendingApprovals`, `getLegacyPendingAction`, `claimPendingAction`, `cancelApprovalRun`, `settlePendingAction`, `resumeRunAfterApproval`, `executeActions`, `normalizeActionResultsForClient`, `approvedActionSucceeded`, `taskManager.getTask`, `safeAgentTaskSummary` — all pre-existing in `api/index.js`, all already exercised by `/chat`'s natural-language confirm/cancel branches ([api/index.js:7561-7649](api/index.js:7561) for approve, ~[api/index.js:7513](api/index.js:7513) for cancel).
- Produces: `POST /agent/tasks/:id/approval` → `{ task: <AgentTask JSON>, resolved: true, decision: "approve"|"deny" }` on success, matching the existing `{ task: ... }` envelope shape used by `PATCH /agent/tasks/:id` and `POST /agent/tasks`, so `AgentTasksService.resolveApproval` can decode it with the already-existing `AgentTaskEnvelope` type. `AgentTasksService.resolveApproval(id: String, decision: String) async throws -> AgentTask` for iOS callers.

#### Backend

- [ ] **Step 1: Write the failing test for the new helper**

Create `test/smoke/agent-tasks-approval-route.test.js`:

```javascript
const assert = require('node:assert/strict');
const test = require('node:test');

const runtime = require('../../runtime');

function fakeSupabase(rows) {
  const from = table => {
    const state = { filters: {} };
    const matches = row => Object.entries(state.filters).every(([k, v]) => row[k] === v);
    const chain = {
      select() { return chain; },
      eq(key, value) { state.filters[key] = value; return chain; },
      order() { return chain; },
      limit() {
        return Promise.resolve({ data: rows.filter(r => r.__table === table && matches(r)), error: null });
      }
    };
    return chain;
  };
  return { from };
}

runtime.createSupabaseServiceClient = () => fakeSupabase([
  {
    __table: 'agent_runtime_approvals',
    id: 'approval-1', user_id: 'user-1', task_id: 'task-brighton', session_id: null,
    task_goal: 'Find a hotel in Brighton', action_type: 'book_appointment',
    action_payload: { action: { type: 'book_appointment', input: { hotel: 'The Grand' } } },
    user_message: 'book the best option', location: null, native_hints: null,
    status: 'pending', created_at: '2026-08-06T10:00:00.000Z'
  },
  {
    __table: 'agent_runtime_approvals',
    id: 'approval-2', user_id: 'user-1', task_id: 'task-other', session_id: null,
    task_goal: 'Something else', action_type: 'send_email',
    action_payload: { action: { type: 'send_email', input: {} } },
    user_message: '', location: null, native_hints: null,
    status: 'pending', created_at: '2026-08-06T09:00:00.000Z'
  }
]);

const { getPendingApprovalForTask } = require('../../api');

test('getPendingApprovalForTask finds the approval belonging to a specific task', async () => {
  const found = await getPendingApprovalForTask('user-1', 'task-brighton');
  assert.equal(found.approvalId, 'approval-1');
  assert.equal(found.action.type, 'book_appointment');
});

test('getPendingApprovalForTask returns null when the task has no pending approval', async () => {
  const found = await getPendingApprovalForTask('user-1', 'task-with-no-approval');
  assert.equal(found, null);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test test/smoke/agent-tasks-approval-route.test.js
```

Expected: FAIL — `getPendingApprovalForTask` is not exported yet (`TypeError: getPendingApprovalForTask is not a function` or `undefined`).

- [ ] **Step 3: Add the helper in `api/index.js`**

Insert immediately after the existing `getPendingAction` function (after line 3975, i.e. right after its closing brace):

```javascript
// Same two data sources as getPendingAction (the runtime approvals table plus the
// legacy single-preference fallback), but selected by task id instead of by matching
// message text — for a direct approve/deny tap that already knows exactly which task
// it's acting on, there is nothing to disambiguate.
async function getPendingApprovalForTask(userId, taskId) {
  const runtime = await agentApprovals.listPendingApprovals(supabase, userId).catch(() => ({ available: false, approvals: [] }));
  const legacy = await getLegacyPendingAction(userId);
  const candidates = [
    ...(runtime.available ? runtime.approvals : []),
    ...(legacy ? [legacy] : [])
  ];
  return candidates.find(candidate => candidate?.taskId === taskId) || null;
}
```

- [ ] **Step 4: Export it and run the test again**

Add near the other exports (after line 9794):
```javascript
module.exports.getPendingApprovalForTask = getPendingApprovalForTask;
```

```bash
node --test test/smoke/agent-tasks-approval-route.test.js
```

Expected: both tests PASS.

- [ ] **Step 5: Add the route**

Insert after `POST /agent/tasks/:id/run` (after line 9438, before `POST /agent/simulate`):

```javascript
app.post('/agent/tasks/:id/approval', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const decision = String(req.body?.decision || '').toLowerCase();
  if (!['approve', 'deny'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approve" or "deny"' });
  }

  const pendingAction = await getPendingApprovalForTask(userId, req.params.id);
  if (!pendingAction) return res.status(404).json({ error: 'No approval is waiting for that task.' });

  // Same atomic claim as the /chat text-confirm path — prevents a double-tap (or a
  // tap racing a "yes" typed in chat) from executing the action twice.
  const claimed = await claimPendingAction(userId, pendingAction);
  if (!claimed) return res.status(409).json({ error: 'That approval was already handled.' });

  if (decision === 'deny') {
    let cancelled = false;
    try {
      cancelled = await cancelApprovalRun(userId, pendingAction);
    } catch (error) {
      console.warn('[agent-approval] cancel failed:', error.message);
    }
    if (cancelled || !pendingAction.taskId) {
      await settlePendingAction(userId, pendingAction, 'cancelled');
    }
    const task = await taskManager.getTask(userId, req.params.id);
    return res.json({ task: task ? safeAgentTaskSummary(task) : null, resolved: true, decision });
  }

  try {
    let actionResults = await executeActions(userId, [pendingAction.action], {
      userMessage: pendingAction.userMessage || '',
      location: pendingAction.location,
      nativeHints: pendingAction.nativeHints,
      bypassReview: true
    });
    actionResults = normalizeActionResultsForClient(actionResults);
    await settlePendingAction(
      userId,
      pendingAction,
      approvedActionSucceeded(actionResults) ? 'approved' : 'failed'
    );
    await resumeRunAfterApproval(userId, pendingAction, actionResults);
    const task = await taskManager.getTask(userId, req.params.id);
    res.json({ task: task ? safeAgentTaskSummary(task) : null, resolved: true, decision });
  } catch (e) {
    // Mirrors the /chat catch block: restore the pending action so the user isn't
    // left with a silently dropped approval if execution itself throws.
    await setPendingAction(userId, pendingAction.action, {
      userMessage: pendingAction.userMessage,
      location: pendingAction.location,
      nativeHints: pendingAction.nativeHints,
      persistedTaskId: pendingAction.taskId,
      runtimeSessionId: pendingAction.sessionId,
      taskGoal: pendingAction.taskGoal,
      approvalId: pendingAction.approvalId
    }).catch(() => {});
    res.status(500).json({ error: 'Could not complete that action.' });
  }
});
```

- [ ] **Step 6: Run the full backend suite**

```bash
npm test
```

Expected: all tests pass, count is 791 + 2 new = 793.

- [ ] **Step 7: Commit backend changes**

```bash
git add api/index.js test/smoke/agent-tasks-approval-route.test.js
git commit -m "$(cat <<'EOF'
feat(api): add POST /agent/tasks/:id/approval for direct approve/deny

Reuses the exact claim/execute/settle/resume logic the /chat natural-language
confirm and cancel branches already use, so a Home card can resolve an approval
directly without requiring the user to be in a conversation. Chat's own
confirm/cancel-by-message path is unchanged and still works.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

#### iOS

- [ ] **Step 8: Add the service call**

In `OxyApp/OxyApp/Services/AgentTasksService.swift`, add (near `updateTask`):

```swift
    static func resolveApproval(id: String, decision: String) async throws -> AgentTask {
        let data = try await APIClient.shared.request(
            path: "/agent/tasks/\(id)/approval",
            method: "POST",
            body: ["decision": decision]
        )
        return try JSONDecoder().decode(AgentTaskEnvelope.self, from: data).task
    }
```

- [ ] **Step 9: Add `awaitingApproval` to `HomeMission` and set it**

In `OxyApp/OxyApp/Views/Home/AgenticHomeView.swift`, in `struct HomeMission` (line 1165), add one field after `watchID`:

```swift
    var watchID: String? = nil
    /// Set only for `.agent` missions built from a task's `awaitingApproval` flag —
    /// drives MissionCardView's approve/deny branch instead of the single generic CTA.
    var awaitingApproval: Bool = false
```

In `persistentTaskMissions` (line 640), change the `active` mapping:

```swift
        let active = agentTasks
            .filter { $0.isActive && $0.status.lowercased() != "recipe" }
            .prefix(3)
            .map { task in
                let lower = task.status.lowercased()
                let eyebrow: String
                let cta: String?
                switch lower {
                case "running": eyebrow = "Handling"; cta = "Open"
                case "failed": eyebrow = "Needs your attention"; cta = "Review"
                case "paused" where task.awaitingApproval: eyebrow = "Needs your OK"; cta = nil
                case "paused": eyebrow = "Paused"; cta = "Resume"
                default: eyebrow = "Ready"; cta = "Start"
                }
                return HomeMission(
                    id: "persistent-task-\(task.id)",
                    kind: .agent,
                    eyebrow: eyebrow,
                    title: task.goal,
                    detail: lower == "running" ? "Adam is handling this." : lower == "paused" ? "Saved and ready to continue." : "Ready when you are.",
                    cta: cta,
                    prompt: nil,
                    symbol: "circle.dotted",
                    isPrimary: lower != "running",
                    taskID: task.id,
                    awaitingApproval: task.awaitingApproval
                )
            }
```

(Only the `switch` statement's `"paused"` handling and the trailing `awaitingApproval:` argument are new; everything else in this block is unchanged.)

- [ ] **Step 10: Add the approval card branch to `MissionCardView`**

Add two new properties near `onMailCTA`/`onDismiss` (line ~1350):

```swift
    var onApprove: (String) -> Void = { _ in }
    var onDeny: (String) -> Void = { _ in }
    var isResolvingApproval: Bool = false
```

Change the top-level fork (line 1405) from:

```swift
        if mission.kind == .mailGroup {
            mailGroupCard
                .padding(16)
                .background { MissionGlassPlate() }
        } else {
```

to:

```swift
        if mission.kind == .mailGroup {
            mailGroupCard
                .padding(16)
                .background { MissionGlassPlate() }
        } else if mission.awaitingApproval {
            approvalCard
                .padding(16)
                .background { MissionGlassPlate() }
        } else {
```

Add the new `approvalCard` view (near `pillCTA`, e.g. after line 1785):

```swift
    // MARK: - Approval (independent buttons, not the generic single-CTA tap target —
    // mirrors mailGroupCard's precedent of rendering outside the shared tappable Button
    // wrapper so two real, separately-tappable controls don't fight a disabled parent)

    private var approvalCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(mission.eyebrow)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(accent)
                Text(mission.title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = mission.detail {
                    Text(detail)
                        .font(.system(size: 13))
                        .foregroundStyle(ink.opacity(0.55))
                }
            }

            HStack(spacing: 10) {
                Button {
                    guard let id = mission.taskID else { return }
                    onDeny(id)
                } label: {
                    Text("Not now")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(ink)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Capsule().fill(ink.opacity(0.07)))
                }
                .buttonStyle(.appScale(0.96))
                .disabled(isResolvingApproval)

                Button {
                    guard let id = mission.taskID else { return }
                    onApprove(id)
                } label: {
                    Text("Approve")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Capsule().fill(Color.black))
                }
                .buttonStyle(.appScale(0.96))
                .disabled(isResolvingApproval)
            }
        }
    }
```

- [ ] **Step 11: Wire it up in `AgenticHomeView`**

Add state near `stoppingWatchIDs` (line 60):

```swift
    @State private var resolvingApprovalTaskIDs: Set<String> = []
```

Add handlers near `stopWatch` (after line ~750):

```swift
    private func approveTask(_ taskID: String) {
        guard !resolvingApprovalTaskIDs.contains(taskID) else { return }
        HapticManager.shared.impact(.medium)
        resolvingApprovalTaskIDs.insert(taskID)
        Task {
            defer { resolvingApprovalTaskIDs.remove(taskID) }
            do {
                _ = try await AgentTasksService.resolveApproval(id: taskID, decision: "approve")
            } catch {
                await MainActor.run { errorMessage = "Could not approve that." }
            }
            await load(forceCheck: true)
        }
    }

    private func denyTask(_ taskID: String) {
        guard !resolvingApprovalTaskIDs.contains(taskID) else { return }
        HapticManager.shared.impact(.light)
        resolvingApprovalTaskIDs.insert(taskID)
        Task {
            defer { resolvingApprovalTaskIDs.remove(taskID) }
            do {
                _ = try await AgentTasksService.resolveApproval(id: taskID, decision: "deny")
            } catch {
                await MainActor.run { errorMessage = "Could not update that." }
            }
            await load(forceCheck: true)
        }
    }
```

Update the `MissionCardView` construction (line 111-119) to pass the new closures:

```swift
                                    MissionCardView(
                                        mission: mission,
                                        ink: GlebChrome.ink,
                                        onCTA: { handleMissionCTA(mission) },
                                        onMailCTA: { email in handleMailCTA(email) },
                                        onDismiss: mission.kind == .mailGroup || mission.watchID != nil ? nil : {
                                            mission.id.hasPrefix("session-") ? abandonSession(mission.id) : dismissMission(mission.id)
                                        },
                                        onApprove: { id in approveTask(id) },
                                        onDeny: { id in denyTask(id) },
                                        isResolvingApproval: mission.taskID.map { resolvingApprovalTaskIDs.contains($0) } ?? false
                                    )
```

- [ ] **Step 12: Build**

```bash
xcodebuild -project OxyApp/OxyApp.xcodeproj -scheme OxyApp -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16' build 2>&1 | tail -40
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 13: Manual verification in the simulator**

1. Trigger a real review-gated action from chat (e.g. ask Adam to send an email or book something that hits a `bypassReview`-gated action) so a task ends up `paused` with `awaitingApproval: true`.
2. Return to Home — confirm the mission card now shows "Needs your OK" with **Approve** / **Not now** buttons instead of a single generic CTA.
3. Tap **Approve** — confirm the action executes, the card updates/clears on the next refresh, and (if the task had more steps) it resumes.
4. Repeat and tap **Not now** — confirm the task is cancelled and the card clears.
5. Confirm chat's existing natural-language path still works unmodified: trigger another approval, go into chat, and type "yes" — confirm it still resolves exactly as before.

- [ ] **Step 14: Commit iOS changes**

```bash
git add OxyApp/OxyApp/Services/AgentTasksService.swift OxyApp/OxyApp/Views/Home/AgenticHomeView.swift
git commit -m "$(cat <<'EOF'
feat(ios): add direct approve/deny buttons to Home's awaiting-approval cards

Additive to chat's existing natural-language confirm/cancel — a task waiting
on approval can now be resolved with a tap from Home without opening a
conversation, calling the new POST /agent/tasks/:id/approval endpoint.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Risks

1. **Cloud Run's 300s request timeout can kill a chat-triggered task's first turn** before it ever becomes a background-resumable run, independent of the client. Documented in Task 2. Not fixed in this plan (infra change, needs an explicit decision). Recommend deciding this before Task 1 ships to real users, since Task 1 makes chat the *only* on-ramp for exactly the kind of request (multi-site browser automation) most likely to run long.
2. **`AgentPlanGenerator` deletion could have a caller the audit's grep missed** if this file has changed since the audit was written (e.g. concurrent Xcode work). Task 1 Step 1 re-runs the grep immediately before editing specifically to catch this.
3. **Nested-button hit-testing**: the plan deliberately avoids nesting the new Approve/Deny buttons inside the existing outer tappable `Button` (which SwiftUI would disable them under via `.disabled(!isTappable)`) by following `mailGroupCard`'s existing precedent of a separate top-level branch. Verify this visually in Step 13 rather than trusting it structurally — SwiftUI hit-testing inside `ScrollView`/`LazyVStack` with `.buttonStyle(.appScale)` on adjacent buttons is exactly the kind of thing that looks right in code review and taps the wrong thing on device.
4. **Double-resolution race**: a task could be approved from a Home card at the same moment the user types "yes" in an open chat thread. `claimPendingAction`'s atomic compare-and-delete (runtime table) / compare-and-delete (legacy preference) already exists specifically to make only one of two racing requests win — this plan doesn't need to add new locking, but Step 13's manual verification should include trying to trigger this (rapid-fire both) at least once.
5. **`safeAgentTaskSummary(task)` returning `null`-shaped data**: if `taskManager.getTask` returns `null` right after settling an approval (e.g. the task was deleted concurrently), the route returns `{ task: null, resolved: true, ... }` — `AgentTaskEnvelope` decoding on iOS will fail to decode a `null` task. This is an edge case (task deleted mid-approval) worth a defensive check if it comes up in testing, not pre-emptively built out now per YAGNI.
6. **Removing the wizard on-ramp for shopping/ride requests** (Task 1, Step 6.3) means those flows now execute through chat's existing action-execution path instead of `AgentTaskSessionView`. This was verified to already work (chat already calls `executeActions`/`run_browser_task` for these), but it is a real behavior change for two previously wizard-routed intents (food orders, rides) worth extra attention in manual testing, not just the Brighton example.

## Self-Review

**Spec coverage:**
- User step 1 (remove the jobKind fork) → Task 1.
- User step 2 (route composer input into the same conversational flow, let the backend start work naturally) → Task 1 (the removal itself achieves this; confirmed no backend change is needed since `persistTask: true` already fires from any chat turn).
- User step 3 (confirm work survives leaving the conversation, appears on Home) → Task 2, plus Task 1 Step 6.2 exercises it manually inline.
- User step 4 (direct approval actions on Home cards, natural-language approval preserved) → Task 3, with Step 13.5 explicitly re-verifying chat's path still works.
- Global constraint "don't promote Work/Trust Center" → not touched by any task.
- Global constraint "don't redesign AgentTaskSessionView" → not touched; only its one caller via the fork is removed, per user's explicit framing ("first fix the underlying split").

**Placeholder scan:** no TBD/TODO markers; every step has literal code or literal commands with expected output.

**Type consistency:** `AgentTasksService.resolveApproval` returns `AgentTask` via the existing `AgentTaskEnvelope` — same envelope type used by `createTask`/`updateTask`, no new decode type introduced. `HomeMission.awaitingApproval` is read in `MissionCardView` via the same `mission` property already passed everywhere else. `getPendingApprovalForTask` return shape matches what `agentApprovals.normalizeApproval` / `getLegacyPendingAction` already produce (an object with `.taskId`, `.action`, `.approvalId`, etc.) — the same shape `getPendingAction` already returns and that `resumeRunAfterApproval`/`cancelApprovalRun`/`claimPendingAction`/`settlePendingAction` already consume, so no adapter is needed between the new helper and the existing functions.
