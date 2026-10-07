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

## Smoke and carbon monoxide alarms: `alarm/`
Apple's model can't tell a smoke alarm from an alarm clock, so `AlarmPatternDetector` listens for the
international beep patterns instead (smoke: three beeps then a pause; CO: four short beeps then a pause), and
only calls plain rapid beeping an alarm after 30 s. See the header of `alarm/main.swift` to run it. The real
recordings are BigSoundBank (CC0) sounds 0800 (smoke, T3), 0925 (CO, T4) and 1153 (rapid beeper), as 16 kHz wavs.

Result, 2026-10-07: all 3 real alarms and all 7 synthetic cases right (including an alarm as loud as the
room noise, a 520 Hz low-frequency alarm, and an alarm clock switched off after 20 s). Across the 2,000 ESC-50
clips looped to 45 s: 0 called a smoke alarm, 0 called a CO alarm, and 2 called sustained beeping (both
alarm clocks). A looped rooster crow once matched the CO timing; beeps must now be a tone inside the band,
not sound spilling in from its edge.
