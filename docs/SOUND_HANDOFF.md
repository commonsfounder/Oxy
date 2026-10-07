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

## Open pretrained model for the BOX-3: EfficientAT mn04 (2026-10-07)
Free route instead of Apple's (unavailable): github.com/fschmid56/EfficientAT, MIT, `mn04_as` (0.98M weights, 0.11 GMACs per 10 s of audio, trained on AudioSet).
Needs PyTorch (installed in `/private/tmp/claude-501/torchenv`, temporary; `pip install torch torchaudio torchvision`). Scripts in `test/dev/sound-eval/tiny/`:
`extract.py` runs the network once per window and caches embeddings + AudioSet scores (parallel shards), `head.py` trains a 384-128-5 head on the cache and
scores from the cache (seconds). Zero-shot (no training): baby crying fine, knock ok, glass ~0, doorbell weak. With our head (frozen backbone, 2 s windows):
30-min stream, 36 of each, at threshold 0.95, found / false alarms per hour: glass 17 / 16, knock 14 / 12, doorbell 7 / 12, baby 20 / 14.
For comparison phone v2: 16 / 6, 12 / 2, 8 / 0, 20 / 6; Apple: 9 / 0, 12 / 2, 1 / 0, 13 / 0; numpy tiny: 0 / 0, 1 / 4, 1 / 4, 10 / 6.
Verdict: about as many catches as v2 but 2-6x the false alarms; far better than the numpy model. Same catch-vs-false curve as v2 when thresholds are matched
(clean glass: v2 at -0.3 104 caught / 19 false, head 99 / 17). Next: fine-tune the backbone (not only the head), add mined negatives, int8 export, measure
speed on the ESP32-S3 (the 0.11 GMAC figure is per 10 s of 32 kHz audio; the BOX-3 mic is 16 kHz, so audio must be upsampled or the model retrained at 16 kHz).
Saved: `saved/models/efficientat-mn04-head-v1.pt`, `saved/benchmarks/efficientat-mn04-*`. Embedding caches (`scratchpad/emb/*.pkl`) are not saved; rerun `extract.py` (~15 min with 4 shards).
Competitor to know: Seeed Sound Event Detection Module D1 (AIZIP model) already does baby cry, glass break, gunshot, T3/T4 alarms and snore locally.

## Whole-network fine-tune of EfficientAT mn04 (2026-10-07): the best model so far
`tiny/finetune.py` (prep -> train): all 0.98M weights trained on the same data, 3,000 steps (batch 64) in 17 minutes on the Mac GPU (`mps`; CPU was 47x slower).
Weights `saved/models/efficientat-mn04-finetuned-v1.pt` (5-class head, 2 s windows at 32 kHz mel), results `saved/benchmarks/efficientat-mn04-finetuned-v1-*`.
30-min stream at threshold 0.95, 36 of each, found / false alarms per hour: glass 18 / 6, knock 15 / 4, doorbell 8 / 6, baby 18 / 2.
Phone v2: 16 / 6, 12 / 2, 8 / 0, 20 / 6. Apple: 9 / 0, 12 / 2, 1 / 0, 13 / 0. Head only: 17 / 16, 14 / 12, 7 / 12, 20 / 14.
At matched false alarms in hard conditions it beats v2 on glass and knock (echo: glass 89 caught / 11 false vs v2 78 / 15; knock 103 / 11 vs v2 79 / 13);
baby crying ties; doorbell ties or is slightly worse (noise: 9 / 13 vs v2 10 / 7). Fine-tuning cut the head-only false alarms 2-7x.
Pipeline to reproduce (all cached, scripts in `tiny/`): `finetune.py prep` (6 shards) -> `finetune.py train` -> `FT_WEIGHTS=<pt> extract.py ... eval` (4 shards) -> `head.py eval <emb> <stress> <stream> probs`.
Not done: 16 kHz retrain for the BOX-3 mic, int8 export, on-chip speed, Core ML conversion for the phone (coremltools not installed), mined negatives on this model.

## Final hardware model: 15 sounds, 16 kHz, 8-bit ready (2026-10-07)
**What it is:** EfficientAT mn04 (MIT), whole network fine-tuned, 16 kHz spectrogram front end (the BOX-3 mic's native rate), 2 s windows every 0.5 s,
16 outputs: background + alarm, baby_crying, cough, dog_bark, door_slam, doorbell, glass_breaking, gunshot, knock, microwave, phone_ring, scream, siren,
toilet_flush, water_running. 721,456 weights = 0.72 MB as int8, 23 M multiply-adds per window (47 M per second of audio), largest layer output 155 KB.
Quantisation-aware training (`tiny/qat.py`) gives an 8-bit network scoring the same as float (val windows 0.497 vs 0.516 float; ROC identical within noise).
Files: `saved/models/efficientat-mn04-16k-15sounds-{float,int8sim}.pt`, `.scales.json`, `.classes.json`; results `saved/benchmarks/final-*`.
**Not verified on the chip:** nothing here was run on an ESP32-S3. Speed and memory are estimates from operation and layer counts; weights are on the int8 grid but there is no ESP-DL / TFLite-Micro export yet.

**Benchmark (stress2: 8 hard conditions, FSD50K eval clips, test-only, threshold-free):** recall at 1% false alarms averaged over six conditions / AUC.
Apple vs final int8: alarm .09/.69 vs .11/.82; baby .75/.96 vs .60/.96; cough .58/.84 vs .65/.95; dog_bark .70/.87 vs .68/.95; door_slam .11/.64 vs .20/.86;
doorbell .33/.77 vs .24/.88; glass .39/.71 vs .62/.95; gunshot .34/.60 vs .44/.91; knock .40/.75 vs .69/.94; microwave .38/.76 vs .34/.88; phone_ring .24/.63 vs .26/.91;
scream .27/.62 vs .43/.95; siren .77/.93 vs .62/.92; toilet_flush .69/.97 vs .74/.98; water_running .46/.88 vs .49/.95.
Clear wins: glass, knock, scream, gunshot, cough, door_slam. Ties: dog, toilet, water, microwave, phone. **Apple still wins at the strict operating point: baby crying, siren, doorbell (hard conditions).**
Phone model v2 (Apple-feature head): glass .56, knock .51, baby .73, doorbell .28. Earlier 5-sound EfficientAT: glass .61, knock .58, baby .67, doorbell .21 (adding 10 sounds cost baby ~0.07, helped knock).
**Streams** (`stream2-tune` even clips / `stream2-check` odd clips, 2 h each, 60 events per 15 min): calibrated at <= 1 false alarm per hour on the tuning set, unseen check set:
glass 12/32 (3.5/h), toilet 17/32, siren 15/32, dog 21/32, cough 9/32, baby 9/32, knock 9/32 (3.5/h), ~0 for door_slam, doorbell, alarm, scream. Sensitive profile (<= 4/h): glass 14, knock 15, scream 12, siren 20, toilet 23, dog 23, cough 16.
Settings: `firmware/sound-events/sound_events_config.h` (strict) and `sound_events_config_sensitive.h`, generated by `tiny/make_config.py`; the C logic is replayed against the Python calibration (`tiny/check_c_logic.py`) and matches exactly.
**Val-window accuracy (~52%) is misleading:** 43% of validation windows are background and only 32% are called background, because background deliberately includes look-alikes (pouring water, chimes, thumps, bells) that are acoustically near the targets. Removing them would raise the number and worsen real false alarms.
**Alarm patterns on 12 real fire/smoke alarm recordings (FSD50K):** 3 detected (clean T3 patterns, including one distant one fixed by closing echo dropouts); the other 9 are fire bells/horns (not beep patterns) or 2 s snippets: the learned `alarm` class (recall at 1% FPR only .11) is weak, so bells and horns remain a gap.
**Pipeline (all scripts in `test/dev/sound-eval/`):** `train/prepare2.py` (+ `fetch.py`) -> `train/augment2.py` -> `tiny/finetune.py prep|train` -> `tiny/qat.py` -> `tiny/extract.py` (cached scores) -> `tiny/eval15.py`, `tiny/calibrate.py`, `tiny/make_config.py`, `tiny/budget.py`, `tiny/check_c_logic.py`. GPU (`mps`) trains in ~25 s per 100 steps; keep the Mac awake (`caffeinate`) or jobs pause when it sleeps; do not run training and 4 extraction shards at once (memory thrash).

## Capacity test: mn10 (5x the network) — the accuracy ceiling (2026-10-07)
Same data, 16 kHz front end, whole-network fine-tune plus head warm start from the AudioSet rows and weight averaging (`ARCH=mn10_as WARM=1 EMA=1 tiny/finetune.py`).
Val-window accuracy 0.555 (mn04: 0.516). Threshold-free benchmark, recall at 1% false alarms averaged over the six conditions, Apple | mn04 int8 | mn10:
mean over 15 sounds 0.43 | 0.47 | 0.56. mn10 wins or ties Apple on 14 of 15 sounds (baby .75 vs .73 tie; siren .77 vs .70 still Apple's); biggest gains over mn04: doorbell .24 -> .40,
phone_ring .26 -> .38, microwave .34 -> .46, toilet .74 -> .83, gunshot .44 -> .52, cough .65 -> .72, dog .68 -> .77, baby .60 -> .73, water .49 -> .56.
Cost (`budget.py`, ARCH=mn10_as): 4,222,240 weights = 4.2 MB int8, 115 M multiply-adds per 2 s window (230 M per second of audio at 2 windows/s, 115 M at 1/s),
largest layer output 414 KB (needs external RAM on the BOX-3); mn04 is 0.72 MB, 23 M per window, 155 KB. Neither measured on the chip.
Weights `saved/models/efficientat-mn10-16k-15sounds-float16.pt` (stored as float16, loads into the float32 network).
Speed notes: the Mac GPU is the limit (about 200 windows/s for mn04 training); on-GPU data path, bf16/fp16 and bigger batches gave no speed-up; keep other jobs off the GPU while training; plug in, quit heavy apps; sleep pauses jobs (`caffeinate`).

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
