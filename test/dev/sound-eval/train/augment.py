#!/usr/bin/env python3
"""Adds the conditions the app really meets to the training set: noise, echo, distance, and short sounds
that arrive inside a running stream. Test clips are never touched.

  python3 augment.py <soundset folder> <out folder>

Each target clip becomes itself plus 3 variants; background clips plus 1. Doorbell has so few clips that
it gets 6 variants. Val is augmented the same way (once) so validation looks like the app's conditions.
"""
import sys
from pathlib import Path

import numpy as np

import audiolib as audio

soundset, out = Path(sys.argv[1]), Path(sys.argv[2])
rng = np.random.default_rng(5)
noise_pool = [x for x in (audio.load(p) for p in sorted((soundset / "train" / "background").glob("*.wav"))) if x is not None and len(x) > audio.RATE]
print(f"{len(noise_pool)} noise clips")


def vary(x, is_target):
    """One random variant of a clip."""
    if rng.random() < 0.35:  # a short piece of it inside a few seconds of room noise
        seconds = rng.uniform(0.5, 3.0)
        piece = audio.loudest(x, seconds) if is_target else x[:int(seconds * audio.RATE)]
        bed = audio.noise_like(noise_pool, len(piece) + int(rng.uniform(1.5, 4) * audio.RATE), rng) * 0.03
        start = int(rng.uniform(0.3, (len(bed) - len(piece)) / audio.RATE - 0.3) * audio.RATE)
        level = audio.rms(bed) * 10 ** (rng.uniform(3, 20) / 20)
        bed[start:start + len(piece)] += piece / max(audio.active_rms(piece), 1e-6) * level
        x = bed
    elif rng.random() < 0.8:  # noise under the whole clip
        x = audio.mix(x, audio.noise_like(noise_pool, len(x), rng), rng.uniform(0, 20))
    if rng.random() < 0.4:
        x = audio.reverb(x, rng)
    return audio.normalise(x * 10 ** (rng.uniform(-25, 0) / 20))


for split, variants in (("train", None), ("val", 1)):
    for folder in sorted((soundset / split).iterdir()):
        label = folder.name
        count = variants or (1 if label == "background" else 6 if label == "doorbell" else 3)
        for path in sorted(folder.glob("*.wav")):
            x = audio.load(path)
            if x is None or len(x) < audio.RATE // 2:
                continue
            target = out / split / label
            target.mkdir(parents=True, exist_ok=True)
            if split == "train":
                audio.save(target / f"{path.stem}.wav", audio.normalise(x))
            for n in range(count):
                audio.save(target / f"{path.stem}_a{n}.wav", vary(x, label != "background"))
    print(f"{split} done")
