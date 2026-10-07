# Saved sound models and the Apple benchmark (2026-10-07)

Models (Create ML sound classifiers on Apple's built-in audio features, iPhone only, 17 KB each):
- `models/household-v1-clean.mlmodel`: trained on clean clips (commit dab69a5b).
- `models/household-v2-real-rooms.mlmodel`: trained with noise, echo, distance and short sounds mixed in. This is the one in the app (`OxyApp/Resources/HouseholdSounds.mlmodel`, commit 45d1e30f).
Classes: glass_breaking, knock, doorbell, baby_crying, background. Training data and credits: `docs/sound-model-credits.csv`.

Benchmarks, all with the app's own thresholds and windows-in-a-row rule:
- `benchmarks/stress-apple-v1-v2.txt`: Apple | v1 | v2 on 677 held-out clips in 8 conditions.
- `benchmarks/stream-apple-v1-v2.txt`: 30 minutes of household noise with 144 sounds dropped in at random.
- `benchmarks/esc50-apple-*.json`: Apple's classifier alone on ESC-50, before and after the per-sound hit rule.
Not saved (too big, rebuild with `peaks.swift`): the per-label scores for every ESC-50 clip (42 MB).
Rebuild the test sets with `train/prepare.py`, `train/stress.py`, `train/stream.py`; see `../README.md`.
