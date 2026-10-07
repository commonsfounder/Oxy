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

## Hard conditions and long recordings (train/)
Clean 5-second clips flatter every model. `train/stress.py` rebuilds the held-out clips in 8 conditions (household
noise at two levels, faint, echo, a 1 s or 0.5 s sound inside 6 s of room noise, and everything at once) and
`train/stress.swift` scores Apple's model and ours on all of them with the app's settings. `train/stream.py` +
`stream.swift` do the same on 10-minute recordings with sounds dropped in at random times (-3 to +12 dB against the
background), counting false alarms per hour. `train/augment.py` mixes the same conditions into the training set.
A bare 0.5 s or 1 s file gives these models no full window, so short sounds are always tested inside a stream.

Result, 2026-10-07 (caught / 112 glass, 128 knock, 110 baby; false alarms in brackets). Apple | ours trained on clean clips | ours trained with the conditions mixed in:
| | clean | noise 10 dB | noise 0 dB | echo | all at once |
|---|---|---|---|---|---|
| glass | 40 (0) / 97 (5) / 93 (1) | 30 (0) / 77 (25) / 73 (9) | 21 (0) / 49 (27) / 48 (6) | 0 (0) / 63 (12) / 55 (4) | 1 (0) / 24 (20) / 24 (6) |
| knock | 66 (3) / 98 (4) / 100 (2) | 38 (0) / 57 (0) / 70 (1) | 23 (0) / 37 (2) / 38 (1) | 3 (0) / 51 (4) / 63 (6) | 1 (0) / 13 (3) / 16 (2) |
| baby | 73 (0) / 91 (1) / 103 (4) | 44 (0) / 62 (3) / 91 (4) | 24 (0) / 44 (3) / 68 (5) | 41 (0) / 66 (0) / 93 (2) | 8 (0) / 32 (2) / 60 (5) |

In 30 minutes of realistic recording (36 of each sound): glass 9 / 16 / 16 found, false alarms per hour 0 / 10 / 6;
knock 12 / 11 / 12 found; doorbell 1 / 8 / 8 found; baby 13 / 16 / 20 found, false alarms per hour 0 / 4 / 6.
Everything is weaker in a noisy room than on clean clips, and doorbell is still weak (27 test clips).
