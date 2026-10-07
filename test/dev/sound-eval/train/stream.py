#!/usr/bin/env python3
"""Builds long household recordings with sounds dropped in at random moments, and the answer key.

  python3 stream.py <soundset folder> <out folder> [beds=3] [minutes=10]

Each bed is ordinary household noise (speech, music, appliances from the validation split) at a steady level.
Held-out target sounds are placed at random times with a random loudness from 3 dB below the bed to 12 dB
above it. The app never sees a tidy 5-second clip; it sees this.
"""
import json
import sys
from pathlib import Path

import numpy as np

import audiolib as audio

soundset, out = Path(sys.argv[1]), Path(sys.argv[2])
beds = int(sys.argv[3]) if len(sys.argv) > 3 else 3
minutes = float(sys.argv[4]) if len(sys.argv) > 4 else 10
out.mkdir(parents=True, exist_ok=True)

noise_pool = [x for x in (audio.load(p) for p in sorted((soundset / "val" / "background").glob("*.wav"))) if x is not None and len(x) > audio.RATE]
events_pool = {}
for sound in ("glass_breaking", "knock", "doorbell", "baby_crying"):
    clips = [audio.load(p) for p in sorted((soundset / "test" / sound).glob("*.wav"))]
    events_pool[sound] = [audio.loudest(x, 6.0) for x in clips if x is not None and len(x) > audio.RATE // 4]

for bed_index in range(beds):
    rng = np.random.default_rng(100 + bed_index)
    length = int(minutes * 60 * audio.RATE)
    bed = audio.noise_like(noise_pool, length, rng) * 0.03
    truth, taken = [], []
    for sound, clips in events_pool.items():
        for _ in range(12):
            clip = clips[rng.integers(len(clips))]
            for _attempt in range(50):
                start = int(rng.uniform(10, minutes * 60 - 12) * audio.RATE)
                if all(abs(start - other) > 10 * audio.RATE for other in taken):
                    break
            taken.append(start)
            local = audio.rms(bed[max(0, start - audio.RATE):start + len(clip)])
            level = local * 10 ** (rng.uniform(-3, 12) / 20)
            bed[start:start + len(clip)] += clip / max(audio.active_rms(clip), 1e-6) * level
            truth.append({"sound": sound, "start": start / audio.RATE, "end": (start + len(clip)) / audio.RATE})
    audio.save(out / f"bed{bed_index}.wav", audio.normalise(bed))
    (out / f"bed{bed_index}.json").write_text(json.dumps(sorted(truth, key=lambda e: e["start"])))
    print(f"bed{bed_index}: {len(truth)} events in {minutes} minutes")
