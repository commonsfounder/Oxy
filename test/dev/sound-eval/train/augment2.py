#!/usr/bin/env python3
"""Training-set builder for the 15-class model: like augment.py, but each sound is topped up to roughly the same
number of examples, with speed / pitch changes on top of noise, echo, distance and short-in-a-stream cuts.

  python3 augment2.py <soundset2 folder> <out folder> [extra background clips folder]

Rare sounds (doorbell, siren, ...) get many more variants than common ones. Test clips are never touched. An optional
folder of extra background clips (the model's own past mistakes) is added to training background three ways each.
"""
import sys
from pathlib import Path

import numpy as np

import audiolib as audio

soundset, out = Path(sys.argv[1]), Path(sys.argv[2])
extra = Path(sys.argv[3]) if len(sys.argv) > 3 else None
rng = np.random.default_rng(5)
TARGET_PER_CLASS = 1000
noise_pool = [x for x in (audio.load(p) for p in sorted((soundset / "train" / "background").glob("*.wav"))) if x is not None and len(x) > audio.RATE]
print(f"{len(noise_pool)} noise clips")


def vary(x, is_target):
    if is_target and rng.random() < 0.5:  # a little faster or slower: pitch and tempo move together
        x = audio.resample(x, int(16000 * rng.uniform(0.88, 1.12)))
    if rng.random() < 0.35:  # a short piece of it inside a few seconds of room noise
        seconds = rng.uniform(0.5, 3.0)
        piece = audio.loudest(x, seconds) if is_target else x[:int(seconds * audio.RATE)]
        bed = audio.noise_like(noise_pool, len(piece) + int(rng.uniform(1.5, 4) * audio.RATE), rng) * 0.03
        start = int(rng.uniform(0.3, (len(bed) - len(piece)) / audio.RATE - 0.3) * audio.RATE)
        bed[start:start + len(piece)] += piece / max(audio.active_rms(piece), 1e-6) * audio.rms(bed) * 10 ** (rng.uniform(3, 20) / 20)
        x = bed
    elif rng.random() < 0.8:
        x = audio.mix(x, audio.noise_like(noise_pool, len(x), rng), rng.uniform(0, 20))
    if rng.random() < 0.4:
        x = audio.reverb(x, rng)
    return audio.normalise(x * 10 ** (rng.uniform(-25, 0) / 20))


for split in ("train", "val"):
    for folder in sorted((soundset / split).iterdir()):
        label = folder.name
        files = sorted(folder.glob("*.wav"))
        if label == "background":
            count = 1
        elif split == "val":
            count = 1
        else:
            count = int(np.clip(round(TARGET_PER_CLASS / max(len(files), 1)), 3, 14))
        target = out / split / label
        target.mkdir(parents=True, exist_ok=True)
        for path in files:
            x = audio.load(path)
            if x is None or len(x) < audio.RATE // 2:
                continue
            if split == "train":
                audio.save(target / f"{path.stem}.wav", audio.normalise(x))
            for n in range(count):
                audio.save(target / f"{path.stem}_a{n}.wav", vary(x, label != "background"))
        print(f"{split}/{label}: {len(files)} clips x {count + (1 if split == 'train' else 0)}", flush=True)
if extra is not None:
    target = out / "train" / "background"
    n = 0
    for path in sorted(extra.glob("*.wav")):
        x = audio.load(path)
        if x is None:
            continue
        audio.save(target / f"mined_{path.stem}.wav", audio.normalise(x))
        audio.save(target / f"mined_{path.stem}_n.wav", audio.normalise(audio.mix(x, audio.noise_like(noise_pool, len(x), rng), rng.uniform(0, 12))))
        audio.save(target / f"mined_{path.stem}_e.wav", audio.normalise(audio.reverb(x, rng) * 10 ** (rng.uniform(-20, 0) / 20)))
        n += 1
    print(f"{n} mined background clips added x3")
