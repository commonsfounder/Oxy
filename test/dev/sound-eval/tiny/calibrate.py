#!/usr/bin/env python3
"""Chooses each sound's alert settings (score threshold, windows in a row) and checks them on recordings it never saw.

  python3 calibrate.py <tune cache folder> <tune stream folder> <check cache folder> <check stream folder> <classes.json> <out json> [false alarms per hour allowed=1.0]

A "stream" is a long household-noise recording with known sounds dropped in (train/stream.py); the cache holds the model's
score for every half-second window (tiny/extract.py). For each sound, the setting that finds the most sounds while setting
off at most the allowed false alarms per hour on the tuning streams is picked, then scored on the check streams.
"""
import json
import pickle
import sys
from pathlib import Path

import numpy as np

tune_cache, tune_stream, check_cache, check_stream, classes_file, out = sys.argv[1:7]
allowed = float(sys.argv[7]) if len(sys.argv) > 7 else 1.0
classes = json.loads(Path(classes_file).read_text())
WINDOW_END = 2.0   # seconds into the audio at which the first window ends
COOLDOWN = 30.0


def load(cache, stream):
    data = {}
    for f in sorted(Path(cache).glob("eval-*.pkl")):
        data.update(pickle.load(open(f, "rb")))
    beds = []
    for wav in sorted(Path(stream).glob("bed*.wav")):
        truth = json.loads(wav.with_suffix(".json").read_text())
        beds.append((data[str(wav)][1].astype(np.float32), truth))
    return beds


def fire_times(col, threshold, hits):
    times, run, last = [], 0, -1e9
    for i, v in enumerate(col):
        run = run + 1 if v >= threshold else 0
        t = i * 0.5 + WINDOW_END
        if run >= hits and t - last > COOLDOWN:
            times.append(t)
            last = t
    return times


def score(beds, cls, threshold, hits):
    found = total = false = 0
    hours = 0.0
    for p, truth in beds:
        times = fire_times(p[:, classes.index(cls)], threshold, hits)
        events = [e for e in truth if e["sound"] == cls]
        found += sum(any(e["start"] - 1 <= t <= e["end"] + 3 for t in times) for e in events)
        total += len(events)
        false += sum(not any(e["start"] - 1 <= t <= e["end"] + 3 for e in events) for t in times)
        hours += len(p) * 0.5 / 3600
    return found, total, false / max(hours, 1e-9), hours


tune, check = load(tune_cache, tune_stream), load(check_cache, check_stream)
result = {}
print(f"{'sound':16} {'setting':18} {'tuning: found  false/h':>26} {'unseen check: found  false/h':>32}")
for cls in classes:
    if cls == "background":
        continue
    best = None
    for threshold in (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.97, 0.98, 0.99):
        for hits in (1, 2, 3):
            found, total, fph, hours = score(tune, cls, threshold, hits)
            if total and fph <= allowed and (best is None or found > best[0] or (found == best[0] and fph < best[1])):
                best = (found, fph, threshold, hits, total)
    if best is None:
        print(f"{cls:16} no setting stays within {allowed}/h on the tuning streams")
        continue
    _, _, threshold, hits, _ = best
    f2, t2, fph2, _ = score(check, cls, threshold, hits)
    f1, t1, fph1, _ = score(tune, cls, threshold, hits)
    result[cls] = {"threshold": threshold, "hits": hits, "tune_found": f1, "tune_total": t1, "tune_false_per_hour": round(fph1, 2),
                   "check_found": f2, "check_total": t2, "check_false_per_hour": round(fph2, 2)}
    print(f"{cls:16} thr {threshold:.2f}, {hits} in a row   {f1:>4}/{t1:<4} {fph1:6.2f}/h   {f2:>10}/{t2:<4} {fph2:6.2f}/h")
Path(out).write_text(json.dumps(result, indent=1))
