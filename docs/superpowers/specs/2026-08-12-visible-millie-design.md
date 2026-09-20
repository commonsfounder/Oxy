# Visible Adam — design

**Date:** 2026-08-12
**Goal:** Adam is roughly 4× more capable than she looks. This pass closes that gap. Success is not "tests pass" — it is "I open the app and immediately notice it is more capable and more alive."

## Audit findings (2026-08-12)

The backend carries 111 action contracts across ~38k LOC of services. The app surfaces a fraction.

### Domains with tables and service code but no HTTP route and no UI

| Domain | Service | Route | UI |
|---|---|---|---|
| `workflows`, `workflow_events`, `workflow_checkpoints`, `workflow_links` | `api/services/workflows.js` | none | none |
| `documents`, `document_representations` | `api/services/documents.js` | none | none |
| `commitments` | `api/services/commitments.js` | none | none |

Also route-less and UI-less: `people`/`person_facts`, `occasions`, `notification_events`, `purchases`.

`workflows.js` already defines the exact vocabulary this redesign needs — `gathering`, `working`, `waiting_for_user`, `waiting_external`, `completed` — with a comment stating it exists to derive what the user sees on the home screen. Home has never read it.

### Routes the app never calls

`/agent/tools` (all 111 capabilities plus connector gating), `/action-log/:userId`, `/history/*`, `/agent/tasks/:id/runtime/diff`, `/agent/tasks/:id/run`, `/briefings/:id/read`.

### Views that exist but are unreachable

`RoutinesListView`, `ModelRoutingView`, `AgentWorkspaceView` have no call sites outside their own `#Preview`. `AgentWorkView` — titled "What Adam is handling" — is reachable only by tapping a mission card that happens to carry a `taskID`.

### Home's information model

`AgenticHomeView.missions` builds one flat list capped at 8, mixing inbox mail, deliveries, watches and tasks, sourced mostly from `briefings`. There is no last-seen tracking anywhere, so "what changed" is not merely unbuilt — it is unrepresentable. "Completed" appears only as an incidental "Booked" card.

### Long-running work

SSE exists for `/chat`, and `AgentTaskSession` polls `/tasks/:id/steps`, but only while its sheet is open. A backgrounded job renders as a static one-line card with no steps, no progress and no motion. There is nowhere in the app to watch work happen.

## Blocker found during the audit

Production has been down since 2026-08-08. The Cloud Run URL returns a frontend 503 in ~50ms with no matching log entry, while the control plane reports `Ready=True, ContainerHealthy=True`.

Root cause: billing account `01AF80-F6AF13-04F5AB` is `"open": false`. The project-level `billingEnabled: true` only records that a link exists, not that the account is alive. Every billable API rejects, which is why the Cloud Build trigger — healthy and watching `^main$` — has fired zero times since 08-08.

Consequence: 35 commits are on `origin/main` but have never built, including the entire workflows and documents capability pass. The backend the phone talks to has never heard of either.

Reopening the billing account requires entering payment details and is the user's action. Once open:

```bash
gcloud builds triggers run rmgpgab-oxy-europe-west2-commonsfounder-Oxy--mafyr --branch=main
```

Supabase is unaffected (`ACTIVE_HEALTHY`). Real rows exist for `commitments` (14), `agent_tasks` (182), `briefings` (115), `action_log` (1388). The workflow and document tables exist but are empty, since the code that writes them never deployed.

This pass therefore builds against a local backend pointed at the real Supabase. The same code ships unchanged once billing is restored.

## Design

### Principle

No new primitives. Every capability this pass makes visible already exists and is already tested. The work is read-routes and surfaces.

### 1. Backend — thin routes over existing services

| Route | Backed by | Feeds |
|---|---|---|
| `GET /agent/state` | `listActiveWorkflows`, `getPendingCheckpoints`, `findCommitments`, agent tasks | all four lanes in one call |
| `GET /workflows/:id` | `getTimeline`, `getLinks` | the live timeline screen |
| `POST /workflows/:id/checkpoints/:cid/resolve` | `resolveCheckpoint` | answering "Needs you" from the phone |
| `GET /documents`, `GET /documents/:id/content` | `findDocuments`, `getDocumentBytes` | seeing files Adam made |
| last-seen watermark | new column on `users` | makes "Changed" representable |

### 2. Home becomes the board

The flat `missions` list is replaced by four ordered lanes: **Needs you → Handling → Changed → Completed**.

The existing Gleb chrome survives unchanged: greeting, pastel wash, composer, weather, edge-swipe to Chat. What changes is the substance between them. Today's inbox-mail card folds into **Needs you**, where it belongs.

A live header (`Adam is handling 3 things`) animates while work is in flight. Poll interval drops from a flat 90s to 10s whenever anything is active.

### 3. The workflow timeline

Tapping anything in **Handling** opens a timeline that streams `workflow_events` as they land, with any pending checkpoint inline so the user can unblock without leaving the screen. This screen has never existed in the app.

### 4. Demo — job application, watched live

A job URL opens a durable responsibility. Adam pulls the CV from documents, authors a tailored cover letter as a real DOCX, drives the browser, opens a checkpoint that needs the user, resumes on their answer, and submits. Every stage lands on the timeline as it happens.

### 5. Demo — inbox sweep with a receipt

One tap sweeps the real inbox with a live counter, archives noise, labels the rest, and returns the messages that genuinely need a reply with drafts awaiting approval. Ends with a "what changed" receipt card.

### 6. Verification

Screenshots from the iOS Simulator against the local backend and real Supabase data. `npm test` green is necessary, not sufficient.

## Explicitly out of scope

Per the user's instruction: RLS, provider abstractions, test taxonomy, edge-case hardening, and any new hidden primitive. The only infrastructure touched is the deploy blocker, because no visible interaction can reach the user without it.
