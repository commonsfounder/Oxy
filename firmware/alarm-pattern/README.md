# Alarm pattern detector (C)

Recognises smoke alarms (three beeps, pause) and carbon monoxide alarms (four short beeps, pause) from their
rhythm, not their sound. A port of `OxyApp/OxyApp/Services/AlarmPatternDetector.swift`; both give the same
answers on the same recordings. Steady rapid beeping is only reported after 30 s, so an alarm clock someone
switches off stays quiet.

- No heap, no OS, any sample rate up to 48 kHz. At 16 kHz it does one 256-point FFT every 10 ms and needs about
  7 KB of RAM plus about 5 KB of stack while a frame is analysed. Give the audio task at least 8 KB of stack.
- Feed it mono samples in blocks of any size (`alarm_pattern_process`). It returns a kind the first time it
  recognises one, and does not repeat until `alarm_pattern_reset`.
- For the BOX-3, the microphone is 16 kHz already; take the left channel from the codec read and call it from
  an always-listening task (today the firmware only records when Talk is tapped).

```bash
make test SMOKE=<folder with 0800.wav 0925.wav 1153.wav> ESC50=<ESC-50 folder>
```

Recordings: BigSoundBank (CC0) 0800 smoke T3, 0925 CO T4, 1153 rapid beeper, as 16 kHz mono wavs.
