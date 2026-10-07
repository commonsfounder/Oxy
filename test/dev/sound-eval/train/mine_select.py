#!/usr/bin/env python3
"""Picks extra household clips to hunt for the model's mistakes: commercial-licence FSD50K dev clips that are not
glass, knock, doorbell or crying and are not already in the soundset. Writes the paths for fetch.py.

  python3 mine_select.py <fsd50k folder> <soundset folder> <how many> <out list>
"""
import csv
import json
import random
import sys
from pathlib import Path

fsd, soundset, count, out = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]), Path(sys.argv[4])
COMMERCIAL_OK = {"http://creativecommons.org/publicdomain/zero/1.0/", "http://creativecommons.org/licenses/by/3.0/"}
TARGETS = {"Shatter", "Knock", "Doorbell", "Crying_and_sobbing"}
LOOKALIKES = {"Glass", "Chink_and_clink", "Door", "Sliding_door", "Cupboard_open_or_close", "Drawer_open_or_close",
              "Dishes_and_pots_and_pans", "Cutlery_and_silverware", "Walk_and_footsteps", "Bell", "Alarm", "Tap",
              "Hammer", "Crumpling_and_crinkling", "Typing", "Microwave_oven", "Water_tap_and_faucet", "Dog", "Cat",
              "Child_speech_and_kid_speaking", "Laughter", "Speech", "Music", "Clapping", "Slam", "Thump_and_thud"}
used = {path.stem for path in soundset.rglob("*.wav")}
info = json.load(open(fsd / "FSD50K.metadata" / "dev_clips_info_FSD50K.json"))
look, other = [], []
for row in csv.DictReader(open(fsd / "FSD50K.ground_truth" / "dev.csv")):
    labels = set(row["labels"].split(","))
    if row["fname"] in used or labels & TARGETS or info[row["fname"]]["license"] not in COMMERCIAL_OK:
        continue
    (look if labels & LOOKALIKES else other).append(row["fname"])
random.seed(21)
random.shuffle(look)
random.shuffle(other)
chosen = look[: count * 3 // 4] + other[: count - min(len(look), count * 3 // 4)]
out.write_text("\n".join(str(fsd / "FSD50K.dev_audio" / f"{name}.wav") for name in chosen) + "\n")
print(f"{len(chosen)} clips chosen ({min(len(look), count * 3 // 4)} look-alikes), {len(used)} already used")
