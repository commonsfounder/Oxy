#!/usr/bin/env python3
"""Builds train/val/test folders (one folder per sound) for Adam's household sound model.

Only clips whose licence allows commercial use go in: FSD50K CC0 and CC BY (by-nc and sampling+ are left out),
and Donate-a-Cry (ODbL/DbCL). Files are hard-linked, so this costs no disk space.

  python3 prepare.py <fsd50k folder> <donateacry cleaned data folder> <out folder>
"""
import csv
import hashlib
import json
import os
import random
import sys
from pathlib import Path

fsd, cry, out = (Path(p) for p in sys.argv[1:4])
COMMERCIAL_OK = {"http://creativecommons.org/publicdomain/zero/1.0/", "http://creativecommons.org/licenses/by/3.0/"}
TARGETS = {"glass_breaking": "Shatter", "knock": "Knock", "doorbell": "Doorbell"}
BABY_WORDS = ("baby", "infant", "newborn", "toddler")
# Household sounds most likely to be mistaken for a target; these lead the background class.
HARD_NEGATIVES = {"Glass", "Chink_and_clink", "Door", "Sliding_door", "Cupboard_open_or_close", "Drawer_open_or_close",
                  "Dishes_and_pots_and_pans", "Cutlery_and_silverware", "Walk_and_footsteps", "Bell", "Alarm",
                  "Tap", "Speech", "Child_speech_and_kid_speaking", "Laughter", "Music", "Hammer",
                  "Crumpling_and_crinkling", "Typing", "Microwave_oven", "Water_tap_and_faucet", "Dog", "Cat"}
BACKGROUND_CAP = {"train": 2500, "val": 300, "test": 600}
TARGET_LABELS = set(TARGETS.values()) | {"Crying_and_sobbing"}

random.seed(7)
counts = {}


def link(source, split, label):
    folder = out / split / label
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / source.name
    if not destination.exists():
        os.link(source, destination)
    counts[(split, label)] = counts.get((split, label), 0) + 1


def fsd_split(name, row):
    if name == "eval":
        return "test"
    return "val" if row["split"] == "val" else "train"


for name in ("dev", "eval"):
    info = json.load(open(fsd / "FSD50K.metadata" / f"{name}_clips_info_FSD50K.json"))
    audio = fsd / f"FSD50K.{name}_audio"
    background = {"train": ([], []), "val": ([], []), "test": ([], [])}
    for row in csv.DictReader(open(fsd / "FSD50K.ground_truth" / f"{name}.csv")):
        clip = info[row["fname"]]
        if clip["license"] not in COMMERCIAL_OK:
            continue
        labels = set(row["labels"].split(","))
        source = audio / f"{row['fname']}.wav"
        split = fsd_split(name, row)
        matched = [sound for sound, label in TARGETS.items() if label in labels]
        text = " ".join(clip["tags"] + [clip["title"]]).lower()
        if "Crying_and_sobbing" in labels and any(word in text for word in BABY_WORDS):
            matched.append("baby_crying")
        if len(matched) == 1:
            link(source, split, matched[0])
        elif not matched and not labels & TARGET_LABELS:
            hard, other = background[split]
            (hard if labels & HARD_NEGATIVES else other).append(source)
    for split, (hard, other) in background.items():
        random.shuffle(hard)
        random.shuffle(other)
        cap = BACKGROUND_CAP[split]
        for source in hard[: cap * 2 // 3] + other[: cap - min(len(hard), cap * 2 // 3)]:
            link(source, split, "background")

# Donate-a-Cry: split by the parent's app id (first five dash-separated parts) so one baby never lands in two splits.
for path in sorted(cry.rglob("*.wav")):
    parent = "-".join(path.name.split("-")[:5])
    bucket = int(hashlib.sha1(parent.encode()).hexdigest(), 16) % 10
    link(path, "test" if bucket == 0 else "val" if bucket == 1 else "train", "baby_crying")

for split in ("train", "val", "test"):
    print(split, {label: n for (s, label), n in sorted(counts.items()) if s == split})
