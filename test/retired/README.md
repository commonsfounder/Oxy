# Retired regression suites

`browser-ordering-loop.test.js` is preserved byte-for-byte from the untracked
file found in `test/smoke` on 2026-09-08. It targets the removed `browser-task`
module and `run_browser_task` contract, so importing it broke `npm test` before
any current regression could run inside that file.

It is historical reference, not an executable test of the current runtime.
Current browser primitives, transaction authority and general agency remain
covered by the active smoke suites. Port any still-relevant scenario to those
capabilities; do not restore the retired task-specific reasoning loop.

SHA-256 of the preserved file:
`1695eb13ed3a03b4afd00223f1781b1eb3b292a0b7e8db7846a28a7a2d22d707`
