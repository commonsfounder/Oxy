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

## In progress when this was written
Mining the model's own mistakes ("retrain on false alarms"): `train/mine_select.py` picked 2,400 look-alike household clips,
`train/fetch.py` is downloading them to the scratchpad (`fsd50k/FSD50K.dev_audio`). Next: `train/mine.py prepare`, run
`train/mine.swift` (compiled to `sound-mine`) over them with the v2 model, `mine.py apply` to add the mistakes to
`soundset_aug/train/background`, retrain with `train/train.swift`, compare with `train/stress.swift` and `stream.swift`
(add `v3=<model>.mlmodelc` as another argument). Ship only if glass false alarms fall without losing catches.
The scratchpad is temporary: if gone, rebuild with `fetch.py`, `prepare.py`, `augment.py` (see `test/dev/sound-eval/README.md`).

## Not done / next
1. Install the current build on the iPhone: last install failed because the phone was unavailable (device `00008110-000644503C63A01E`).
2. Continuous per-house learning (doorbell, washing machine end-of-cycle). Idea settled: labels come mostly from signals the user already gives (door opened right after a doorbell sound, alert opened vs swiped away), with a "Not a doorbell, stop these" button on the alert itself; the Right/Wrong list is a testers' tool, not something to ask everyone to do. Nothing built yet.
3. Tiny int8 model (~50-100 KB) for the BOX-3 trained on the same data. The C alarm detector is ready for firmware but not wired into `hardware/esp32-box3` (another session owns it; the BOX-3 only records on a Talk tap today).
4. In-app credits line for the CC BY authors before any App Store release; Preferences currently says sound "stays on this iPhone", which must stay true (no cloud audio check without opt-in wording).
5. More sounds: Apple already has ~300 labels. ESC-50 scoring (`train/peaks.swift`, `best_labels.py`) says toilet flush, vacuum, cough, sneeze, snore, dog, typing, footsteps work well out of the box; washing machine and breathing do not (no usable label). Kettle (`boiling`) untested: no clips.
6. Decision layer idea (Jev / OpenAI Decisions API are text/image only, no audio): feed it text facts about a detected sound, not audio. Not built.

## Gotchas
- Building inside `~/Documents` can break codesign through iCloud xattrs; device installs use `-derivedDataPath /private/tmp/claude-501/oxy-dd-device`.
- Short sounds (0.5-1 s) must be tested inside a longer stream; a bare short file gives the classifier no full window and scores 0 for every model.
- A looped 5 s clip makes any sound perfectly regular; the alarm tests loop on purpose and watch for that (a rooster once matched the CO pattern).
- `project.pbxproj` has another session's `TaskInterfaceView` lines uncommitted; stage only your own hunks.
