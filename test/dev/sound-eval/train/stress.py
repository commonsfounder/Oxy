#!/usr/bin/env python3
"""Builds a hard test: the held-out clips again, but in rooms that aren't ideal and at lengths that aren't 5 s.

  python3 stress.py <soundset folder> <ESC-50 folder> <out folder>

Conditions (each one a folder, one subfolder per sound, like prepare.py's output):
  clean       the clip as it is
  noise10     a household noise bed 10 dB quieter than the sound
  noise0      the same noise as loud as the sound
  quiet       a faint, far-away sound: about -45 dBFS with a little room noise
  reverb      the sound in an echoey room
  blip1s      only the loudest second, dropped into 6 s of room noise (12 dB below it)
  blip05      only the loudest half second, in the same 6 s of room noise
  hard        echo, noise 5 dB below the sound, and a random volume, all at once
Noise comes from the validation split's background clips (speech, music, appliances), never from the test clips.
"""
import sys
from pathlib import Path

import numpy as np

import audiolib as audio

soundset, esc, out = (Path(p) for p in sys.argv[1:4])
rng = np.random.default_rng(11)
ESC_TARGETS = {"glass_breaking": "glass_breaking", "door_wood_knock": "knock", "crying_baby": "baby_crying", "dog": "dog_bark",
               "coughing": "cough", "toilet_flush": "toilet_flush", "siren": "siren"}

noise_pool = [x for x in (audio.load(p) for p in sorted((soundset / "val" / "background").glob("*.wav"))) if x is not None and len(x) > audio.RATE]
pool = []  # (label, name, samples)
for folder in sorted((soundset / "test").iterdir()):
    files = sorted(folder.glob("*.wav"))
    if folder.name == "background":
        files = [files[i] for i in rng.permutation(len(files))[:300]]
    for path in files:
        samples = audio.load(path)
        if samples is not None and len(samples) > audio.RATE // 4:
            pool.append((folder.name, path.stem, samples))
for row in (line.split(",") for line in (esc / "meta" / "esc50.csv").read_text().splitlines()[1:]):
    if row[3] in ESC_TARGETS:
        samples = audio.load(esc / "audio" / row[0])
        if samples is not None:
            pool.append((ESC_TARGETS[row[3]], "esc_" + Path(row[0]).stem, samples))
print(f"{len(pool)} clips, {len(noise_pool)} noise clips")


def blip(snippet):
    """A short sound landing in the middle of a quiet room, the way it reaches the app: inside a running stream."""
    length = 6 * audio.RATE
    bed = audio.noise_like(noise_pool, length, rng)
    bed *= 0.02 / max(audio.rms(bed), 1e-6)
    start = int(rng.uniform(1.5, 3.5) * audio.RATE)
    level = audio.rms(bed) * 10 ** (12 / 20)
    bed[start:start + len(snippet)] += snippet / max(audio.active_rms(snippet), 1e-6) * level
    return bed


def conditions(x):
    noise = audio.noise_like(noise_pool, len(x), rng)
    yield "clean", x
    yield "noise10", audio.mix(x, noise, 10)
    yield "noise0", audio.mix(x, noise, 0)
    faint = audio.mix(x, noise, 15)
    yield "quiet", faint * (0.006 / audio.active_rms(faint))
    yield "reverb", audio.reverb(x, rng)
    for name, seconds in (("blip1s", 1.0), ("blip05", 0.5)):
        yield name, blip(audio.loudest(x, seconds))
    hard = audio.mix(audio.reverb(x, rng), noise, 5)
    yield "hard", hard * 10 ** (rng.uniform(-20, 0) / 20)


for label, name, samples in pool:
    for condition, data in conditions(samples):
        folder = out / condition / label
        folder.mkdir(parents=True, exist_ok=True)
        audio.save(folder / f"{name}.wav", audio.normalise(data))
print("done")
