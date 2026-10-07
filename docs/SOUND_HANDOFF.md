# Household sound: handoff (2026-10-07)

Point Codex here first. Repo rules still apply: read `AGENTS.md`; stage explicit paths only; never stage another session's
files (`api/physical/box3-*.js`, `hardware/`, `data/`, `test/smoke/box3-sensors.test.js`, `test/dev/milgrain-benchmark-*.json`,
`.impeccable/`, `api/physical/HARDWARE_INTEGRATION.md`); no `Co-Authored-By` trailer on commits; `npm test` green before commits.

## What exists (all committed on main, none pushed)

| Piece | Where | Commit |
|---|---|---|
| Apple classifier with a hit rule per sound (glass/knock fire on 1 window, others 2) | `OxyApp/OxyApp/Services/HouseholdSoundMonitor.swift` | 3dd48d0f |
| Smoke / CO alarms by beep rhythm (ISO 8201), steady beeping reported after 30 s; Apple's `smoke_detector` demoted to "An alarm is going off" | `OxyApp/OxyApp/Services/AlarmPatternDetector.swift` | c6459bf6 |
| Same detector in C for firmware, same results, host test | `firmware/alarm-pattern/` | f9082062 |
| Sounds heard page: opt-in 5 s clip per alert, mark Right/Wrong, share marked clips as `sound-verdict-time.wav`; on-device, not backed up, 30 days / 60 clips, wiped on sign-out | `OxyApp/OxyApp/Services/SoundClipStore.swift`, `Views/Settings/SoundClipsPage.swift` | 4e4e5b0f |
| Our own model, runs beside Apple's, same event ids so no double alerts | `OxyApp/OxyApp/Resources/HouseholdSounds.mlmodel` (v2), rules in `HouseholdSoundEventFilter.ownModel` | dab69a5b, 45d1e30f |
| Both models + Apple benchmark saved | `test/dev/sound-eval/saved/` (README inside) | e14ccfec |
| Training / test tooling | `test/dev/sound-eval/train/`, `test/dev/sound-eval/alarm/`, `test/dev/sound-eval/README.md` | various |
| Credits for training clips (CC BY authors) | `docs/sound-model-credits.csv` | dab69a5b |

Model: Create ML `MLSoundClassifier` on Apple's built-in audio features. 17 KB, iPhone only, cannot run on the BOX-3.
Classes: glass_breaking, knock, doorbell, baby_crying, background. Data: commercial-licence FSD50K (CC0 / CC BY only) + Donate-a-Cry (ODbL).

## Results (details: `test/dev/sound-eval/README.md`, `saved/benchmarks/`)
- Clean clips: ours beats Apple on glass (93% vs 60% on ESC-50), is close on knock and baby crying.
- Real rooms: Apple collapses (echo: 0/112 glass), ours holds. v2 (trained with noise/echo/short sounds mixed in) beat v1 almost everywhere: baby crying in noise 62 -> 91 of 110.
- 30-minute realistic stream (36 of each sound): glass 9 / 16 / 16 found (Apple / v1 / v2), false alarms per hour 0 / 10 / 6; baby 13 / 16 / 20; doorbell 1 / 8 / 8; knock a tie at 12.
- Weak spots: doorbell (only 79 train / 27 test clips), glass false alarms (6/h is too many), anything buried in a noisy room (over half missed).
- Thresholds were chosen after looking at the same data, so ESC-50 numbers are slightly optimistic. Only 40 clips per sound there.

## Mining the model's mistakes: done, no gain (2026-10-07)
Scanned 2,310 look-alike household clips (9,240 variants) with v2; 1,099 fooled it (baby 522, glass 319, doorbell 141, knock 117).
Added them x3 as background and retrained: `saved/models/household-v3-mined-NOT-SHIPPED.mlmodel`. At the app's thresholds v3 had about half the
false alarms but lost many catches (knock in echo 63 -> 11). Rerun with thresholds lowered 0.15 and 0.3 (`OURS_DELTA` in `train/stress.swift`),
v3 sits on the same catch-versus-false-alarm curve as v2 (e.g. glass in echo: v2 78 caught / 15 false, v3 74 / 13; baby, everything at once:
v2 77 / 13, v3 76 / 13). So mining only moved the operating point. v2 stays in the app. The 6 glass false alarms an hour in the 30-minute
stream are not fixed by more negatives; next levers: a model not limited to Apple's frozen features, a hit rule or cooldown for glass,
or a second opinion on flagged clips. Results: `saved/benchmarks/stress-v2-v3-*`, `stress-apple-v2-v3.txt`, `stream-apple-v2-v3.txt`.

## From-scratch small model for the BOX-3 (2026-10-07, baseline only)
`test/dev/sound-eval/tiny/tiny.py`: pure numpy, log-mel (32 bands x 32 steps, per-band median removed) -> 1024-64-32-5, ~68k weights (68 KB int8),
trained on the same `soundset_aug` data as the phone model. Saved: `saved/models/tiny-numpy-v1.npz`, `saved/benchmarks/tiny-numpy-v1-eval.txt`.
Result: clearly worse than the Apple-feature model. Same stress set, thresholds 0.8 vs v2 at app thresholds: glass clean 58 caught / 21 false vs v2 93 / 1;
baby clean 53 / 7 vs 103 / 4; 30-min stream (36 each): glass 5 found at 16 false/h vs v2 16 found at 6/h. Not exported to C yet.
Likely fixes, in order: distil from v2/Apple over the ~11k unlabeled-or-weakly-labelled clips on disk (soft labels), a small CNN (needs PyTorch, not
installed), real BOX-3 microphone recordings, then int8 + TFLite-Micro / ESP-DL on the S3.

## Not done / next
1. Install the current build on the iPhone: last install failed because the phone was unavailable (device `00008110-000644503C63A01E`).
2. Continuous per-house learning (doorbell, washing machine end-of-cycle). Idea settled: labels come mostly from signals the user already gives (door opened right after a doorbell sound, alert opened vs swiped away), with a "Not a doorbell, stop these" button on the alert itself; the Right/Wrong list is a testers' tool, not something to ask everyone to do. Nothing built yet.
3. Tiny int8 model (~50-100 KB) for the BOX-3 trained on the same data. The C alarm detector is ready for firmware but not wired into `hardware/esp32-box3` (another session owns it; the BOX-3 only records on a Talk tap today).
4. In-app credits line for the CC BY authors before any App Store release; Preferences currently says sound "stays on this iPhone", which must stay true (no cloud audio check without opt-in wording).
5. More sounds: Apple already has ~300 labels. ESC-50 scoring (`train/peaks.swift`, `best_labels.py`) says toilet flush, vacuum, cough, sneeze, snore, dog, typing, footsteps work well out of the box; washing machine and breathing do not (no usable label). Kettle (`boiling`) untested: no clips.
6. Decision layer idea (Jev / OpenAI Decisions API are text/image only, no audio): feed it text facts about a detected sound, not audio. Not built.

## Apple's 303 labels, scored (2026-10-07)
`test/dev/sound-eval/all_labels.py` + `peaks_dir.swift` score every Apple label on the 6,358 FSD50K clips on disk; result in
`saved/benchmarks/apple-all-labels-fsd50k.txt`. 135 labels map to an FSD50K class; 121 have >= 8 clips: 30 strong (AUC >= 0.90),
21 okay, 70 weak. 168 labels have no FSD50K class (mostly instruments, animals, sports) and are unmeasured. On messy real clips
Apple is far weaker than on clean ESC-50 for the sounds we trained on (glass 0.53 vs 0.99, knock 0.52 vs 1.00). AUC is
optimistic for sounds near-always mixed with others and pessimistic for long clips (peak over more windows); use it to rank, not as accuracy.

## Gotchas
- Building inside `~/Documents` can break codesign through iCloud xattrs; device installs use `-derivedDataPath /private/tmp/claude-501/oxy-dd-device`.
- Short sounds (0.5-1 s) must be tested inside a longer stream; a bare short file gives the classifier no full window and scores 0 for every model.
- A looped 5 s clip makes any sound perfectly regular; the alarm tests loop on purpose and watch for that (a rooster once matched the CO pattern).
- `project.pbxproj` has another session's `TaskInterfaceView` lines uncommitted; stage only your own hunks.
