#!/usr/bin/env python3
"""Turns the model's mistakes into training data.

  python3 mine.py prepare <fetched list> <noise soundset> <out folder>   # clean + noisy + short copies to scan
  python3 mine.py apply <scores.tsv> <scan folder> <aug soundset> [threshold=0.5]   # add the mistakes as background

Only clips from FSD50K's dev set that none of our tests use. A clip counts as a mistake if any variant scored at
least `threshold` for a target sound. Mistakes are added to the training background three times over, each in a
different room (noise, echo, quiet), so the model learns what they are not.
"""
import sys
from pathlib import Path

import numpy as np

import audiolib as audio

rng = np.random.default_rng(31)


def prepare(listing, soundset, out):
    noise_pool = [x for x in (audio.load(p) for p in sorted((Path(soundset) / "train" / "background").glob("*.wav"))) if x is not None and len(x) > audio.RATE]
    out.mkdir(parents=True, exist_ok=True)
    count = 0
    for line in Path(listing).read_text().split():
        path = Path(line)
        x = audio.load(path)
        if x is None or len(x) < audio.RATE // 2 or not path.exists():
            continue
        x = x[: 12 * audio.RATE]
        noise = audio.noise_like(noise_pool, len(x), rng)
        variants = {"clean": x, "noisy": audio.mix(x, noise, 5), "echo": audio.reverb(x, rng)}
        piece = audio.loudest(x, 1.0)
        bed = audio.noise_like(noise_pool, 6 * audio.RATE, rng) * 0.03
        start = int(rng.uniform(1.5, 3.5) * audio.RATE)
        bed[start:start + len(piece)] += piece / max(audio.active_rms(piece), 1e-6) * audio.rms(bed) * 4
        variants["blip"] = bed
        for name, data in variants.items():
            audio.save(out / f"{path.stem}__{name}.wav", audio.normalise(data))
        count += 1
    print(f"{count} clips, {count * 4} variants")


def apply(scores, scan, aug, threshold):
    noise_pool = [x for x in (audio.load(p) for p in sorted((Path(aug) / "train" / "background").glob("*.wav"))) if x is not None and len(x) > audio.RATE]
    worst = {}
    for row in Path(scores).read_text().splitlines():
        file, label, score = row.split("\t")
        clip = file.split("__")[0]
        if float(score) >= threshold and float(score) > worst.get(clip, (0, ""))[0]:
            worst[clip] = (float(score), label)
    target = Path(aug) / "train" / "background"
    by_label = {}
    for clip, (score, label) in worst.items():
        by_label[label] = by_label.get(label, 0) + 1
        source = Path(scan) / f"{clip}__clean.wav"
        x = audio.load(source)
        if x is None:
            continue
        audio.save(target / f"mined_{clip}.wav", audio.normalise(x))
        audio.save(target / f"mined_{clip}_n.wav", audio.normalise(audio.mix(x, audio.noise_like(noise_pool, len(x), rng), rng.uniform(0, 12))))
        audio.save(target / f"mined_{clip}_e.wav", audio.normalise(audio.reverb(x, rng) * 10 ** (rng.uniform(-20, 0) / 20)))
    print(f"{len(worst)} mistakes added x3; they fooled the model as: {by_label}")


if sys.argv[1] == "prepare":
    prepare(sys.argv[2], sys.argv[3], Path(sys.argv[4]))
else:
    apply(sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5]) if len(sys.argv) > 5 else 0.5)
