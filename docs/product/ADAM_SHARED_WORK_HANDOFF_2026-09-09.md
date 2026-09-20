# Cross-device work: implementation and remaining proof

## Intended milestone

Speak a request on the Mac, interrupt and continue naturally, observe the same durable work on the phone, approve a consequential action there, and hear its verified result on the Mac.

## Implemented locally

- A Mac Work surface signs into the same Adam account as the phone. It uses the existing task create/start/read endpoints and the canonical server reasoning and execution lifecycle. It does not introduce another task execution loop.
- Credentials use a server-scoped Keychain item. HTTP is restricted to loopback development addresses; redirects cannot leave the server origin. Passwords are cleared after sign-in.
- The selected task and speech delivery state survive app recreation. Polling observes server-owned work; closing the Mac surface does not cancel the server task. A failed create/start is not automatically retried as a new task.
- Spoken announcements use the bounded task activity receipts. Paused approvals, failures, and completion without a receipt do not become success announcements. Updates are deduplicated.
- Stop speaking interrupts audio without cancelling work. Continue speaking resumes from a conservative speech-engine boundary. The ledger distinguishes generated text from completed playback; it does not prove what a person heard. The currently interrupted word may be replayed.
- iOS Work refreshes even when it previously had no running tasks, allowing Mac-created work to appear. Task details load the current task and pending reviews, and expose exact decisions.
- A review decision includes approvalId and approvalTaskId. The server resolves both within the authenticated user's pending approvals. Missing, mismatched, consumed, and stale IDs do not fall back to interpreting a generic yes.
- The bounded review presentation supports selected calendar/message capabilities only when all input fields can be shown without truncation. Unknown capabilities, additional fields, or oversized payloads do not get a new Confirm button. The existing action execution/claim/resume boundary remains authoritative.

## Important limits

This is not yet the complete intended milestone. The Mac Work path currently uses Adam's server agent, not a remote approval bridge for arbitrary local Codex/Claude actions. The existing local agent interface is preserved separately.

Microphone input is initiated explicitly. Stop/continue controls exist, but always-listening acoustic interruption, echo cancellation, and room-quality interaction are not implemented or proven. Additional spoken requests create new tasks; conversational corrections to the same running task are not implemented by this slice.

The new task-review backend route and exact chat selection are local changes, not deployed. A production-connected phone cannot use them until an appropriate reviewed release. There is no claim of a real consequential action completed through both devices.

## Verification

- Node full suite: 1,855 tests; 1,853 passed, zero failed, two skipped.
- Focused HTTP/review tests: 11 passed. These use the production Express routing with injected task/approval stores; they test authentication, bounded review retrieval and rejection of stale decisions. They do not exercise a live third-party connector.
- Mac Swift suite: 29 passed, zero failures. Includes HTTP-client transport fixtures, honest pending/completion language, and speech-ledger persistence.
- Mac release app built and signed. The rebuilt Work sign-in screen was observed through the UI.
- iOS simulator build succeeded; existing unrelated concurrency warnings remain. New live review interaction is not yet visually verified.
- Undefined-reference check: zero errors, one existing unused-disable warning.

Logs are under /tmp/adam-handoff-*.log. No commits, pushes, deployments, purchases, or outbound messages were made. Existing staged work remains untouched.

## Next proof and implementation

The user unlocked the Mac after a UI-check interruption. The new app is open, and a request to sign in directly with the phone's Adam account is pending. Do not ask for a password in chat or extract credentials from another app.

After sign-in, verify read-only cross-device task visibility. Test the new review endpoints locally or release the explicitly reviewed changes with schema and version checks; do not deploy the dirty combined checkout. Then run a harmless consequential test under explicit approval and read the result back. Do not call the full milestone complete until this proof exists.

Remaining software work: a provider-compatible cross-device session/continuation contract and a measured full-duplex audio path. Do not claim button-based interruption is natural barge-in.

## Wi-Fi sensing question

The user also asked whether the Mac could gain Wi-Fi sensing as "eyes." The proposed experiment is an external supported ESP32 CSI receiver feeding the Mac, with either a router or a second board as transmitter. Begin by measuring motion detection in one area. Neither arbitrary activity recognition nor direct CSI access through the Mac's built-in radio has been established. No sensor hardware was purchased or firmware flashed.

Official references: https://github.com/espressif/esp-csi and https://developer.apple.com/documentation/corewlan/cwnetwork/rssivalue
