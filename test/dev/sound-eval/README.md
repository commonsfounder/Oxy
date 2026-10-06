# Household sound check

Scores Apple's built-in sound classifier the way Adam uses it (same labels, thresholds and
"hits in a row" rule as `HouseholdSoundEventFilter`), against a labelled dataset.

```bash
git clone --depth 1 https://github.com/karolpiczak/ESC-50.git /tmp/ESC-50   # ~850 MB of audio, not committed
swiftc -O test/dev/sound-eval/evaluate.swift -o /tmp/sound-eval
/tmp/sound-eval /tmp/ESC-50 /tmp/sound-eval.json
```

Keep the `rules` list in `evaluate.swift` in step with `HouseholdSoundMonitor.swift`.

## What ESC-50 can and can't tell you
- It has 40 clips each of crying baby, glass breaking and door knock. It has **no doorbell and no smoke alarm**,
  so those two are untested here (use FSD50K's `Smoke_detector_and_smoke_alarm` / `Doorbell` classes).
- Clips are 5 s Freesound recordings, cleaner than a real living room. 40 clips per class means roughly ±15%.
- It is not licensed for commercial use (CC BY-NC); it is here to test, not to train.

## Result, 2026-10-07 (2,000 clips, Apple classifier `.version1`)
| sound | before (2 hits for all) | after (per sound) |
|---|---|---|
| glass breaking | caught 7/40, 0 false alarms | caught **24/40**, 0 false alarms (1 hit, 0.70) |
| knock | caught 15/40, 1 false alarm | caught **34/40**, 3 false alarms (1 hit, 0.80) |
| baby crying | caught 31/40, 0 false alarms | unchanged (2 hits, 0.72); 1 hit would catch 36/40 |
| smoke detector | no test clips; fired on 4 alarm-clock clips | unchanged |

Short sounds (glass, a knock) last about a second, so waiting for two analysis windows in a row missed most of them.
