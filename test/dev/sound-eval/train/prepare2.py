#!/usr/bin/env python3
"""Builds the 15-class training / validation / test folders: our original four sounds plus ten more.

  python3 prepare2.py <fsd50k folder> <donateacry cleaned data folder> <out folder>
  python3 fetch.py <out folder>/missing.txt      # downloads only the clips not on disk; then run this again

Same licence rule as prepare.py (CC0 and CC BY only, plus Donate-a-Cry). A clip counts for a sound only if it matches
exactly one of our sounds. Background is everything else, with look-alikes first. Test clips come only from FSD50K's
own evaluation set, which nothing is trained or tuned on.
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
TARGETS = {
    "glass_breaking": ["Shatter"], "knock": ["Knock"], "doorbell": ["Doorbell"],
    "water_running": ["Water_tap_and_faucet", "Sink_(filling_or_washing)", "Bathtub_(filling_or_washing)"],
    "toilet_flush": ["Toilet_flush"], "dog_bark": ["Bark"], "cough": ["Cough"], "scream": ["Screaming"],
    "door_slam": ["Slam"], "gunshot": ["Gunshot_and_gunfire"], "microwave": ["Microwave_oven"],
    "siren": ["Siren"], "phone_ring": ["Ringtone"], "alarm": ["Alarm"],
}
BABY_WORDS = ("baby", "infant", "newborn", "toddler")
ORIGINAL = {"glass_breaking", "knock", "doorbell", "baby_crying"}
CAP_NEW = 420  # train + val clips per new sound; test keeps up to CAP_TEST
CAP_TEST = 150
HARD_NEGATIVES = {"Glass", "Chink_and_clink", "Door", "Sliding_door", "Cupboard_open_or_close", "Drawer_open_or_close",
                  "Dishes_and_pots_and_pans", "Cutlery_and_silverware", "Walk_and_footsteps", "Bell", "Tap",
                  "Speech", "Child_speech_and_kid_speaking", "Laughter", "Music", "Hammer", "Crumpling_and_crinkling",
                  "Typing", "Water_tap_and_faucet", "Dog", "Cat", "Thump_and_thud", "Clapping", "Crack", "Scratching_(performance_technique)",
                  "Boom", "Explosion", "Fire", "Hiss", "Run", "Pour", "Drip", "Fill_(with_liquid)", "Mechanical_fan", "Engine",
                  "Buzz", "Chime", "Telephone", "Singing", "Shout", "Yell", "Giggle", "Gasp", "Breathing", "Whispering"}
BACKGROUND_CAP = {"train": 3200, "val": 360, "test": 700}
TARGET_LABELS = {c for classes in TARGETS.values() for c in classes} | {"Crying_and_sobbing"}

random.seed(7)
counts, missing, credits = {}, [], []
pool = {"train": {}, "val": {}, "test": {}}  # split -> label -> [(source, uploader, licence, fname)]


def link(source, split, label):
    if not source.exists():
        missing.append(source)
        return
    folder = out / split / label
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / source.name
    if not destination.exists():
        os.link(source, destination)
    counts[(split, label)] = counts.get((split, label), 0) + 1


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
        split = "test" if name == "eval" else ("val" if row["split"] == "val" else "train")
        matched = [sound for sound, classes in TARGETS.items() if labels & set(classes)]
        if len(matched) > 1 and "alarm" in matched:  # FSD50K gives sirens, doorbells and ringtones an "Alarm" parent label
            matched.remove("alarm")
        text = " ".join(clip["tags"] + [clip["title"]]).lower()
        if "Crying_and_sobbing" in labels and any(word in text for word in BABY_WORDS):
            matched.append("baby_crying")
        if len(matched) == 1:
            pool[split].setdefault(matched[0], []).append((source, clip["uploader"], clip["license"], row["fname"]))
        elif not matched and not labels & TARGET_LABELS:
            hard, other = background[split]
            (hard if labels & HARD_NEGATIVES else other).append(source)
    for split, (hard, other) in background.items():
        random.shuffle(hard)
        random.shuffle(other)
        hard.sort(key=lambda p: not p.exists())   # clips already downloaded first; the download is the slow part
        other.sort(key=lambda p: not p.exists())
        cap = BACKGROUND_CAP[split]
        take = hard[: cap * 2 // 3] + other[: cap - min(len(hard), cap * 2 // 3)]
        for source in take:
            link(source, split, "background")
            if split != "test":
                credits.append((source.stem, info[source.stem]["uploader"], info[source.stem]["license"], "background"))

for split in pool:
    for label, items in pool[split].items():
        random.shuffle(items)
        items.sort(key=lambda it: not it[0].exists())
        if label not in ORIGINAL:
            limit = CAP_TEST if split == "test" else CAP_NEW * (9 if split == "train" else 1) // 10
            items = items[:limit]
        for source, uploader, licence, fname in items:
            link(source, split, label)
            if split != "test":
                credits.append((fname, uploader, licence, label))

for path in sorted(cry.rglob("*.wav")):
    parent = "-".join(path.name.split("-")[:5])
    bucket = int(hashlib.sha1(parent.encode()).hexdigest(), 16) % 10
    link(path, "test" if bucket == 0 else "val" if bucket == 1 else "train", "baby_crying")

with open(out / "attribution.csv", "w", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["freesound_id", "author", "licence", "used_as"])
    writer.writerows(sorted(credits))
    writer.writerow(["donate-a-cry", "Donate-a-Cry contributors", "https://opendatacommons.org/licenses/odbl/1-0/", "baby_crying"])
if missing:
    (out / "missing.txt").write_text("\n".join(str(path) for path in missing) + "\n")
    print(f"{len(missing)} clips not on disk; listed in {out / 'missing.txt'}")
for split in ("train", "val", "test"):
    print(split, {label: n for (s, label), n in sorted(counts.items()) if s == split})
