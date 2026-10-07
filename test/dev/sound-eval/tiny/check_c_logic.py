#!/usr/bin/env python3
"""Replays the stream recordings through the C alert logic and compares with calibrate.py's own scoring.

  python3 check_c_logic.py <check cache folder> <check stream folder> <classes.json> <replay binary>
"""
import json
import pickle
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

cache_dir, stream_dir, classes_file, binary = sys.argv[1:5]
classes = json.loads(Path(classes_file).read_text())
cfg = {}
for line in Path(__file__).resolve().parents[4].joinpath("firmware/sound-events/sound_events_config.h").read_text().splitlines():
    line = line.strip()
    if line.startswith('{"'):
        name, thr, _, hits, *_ = [x.strip() for x in line.strip("{},/* ").split("}")[0].replace("{", "").split(",")]
        cfg[name.strip('"')] = (float(thr.rstrip("f")), int(hits))
data = {}
for f in sorted(Path(cache_dir).glob("eval-*.pkl")):
    data.update(pickle.load(open(f, "rb")))
found = {c: [0, 0, 0] for c in classes if c != "background"}   # C found, python found, total
false_c = {c: 0 for c in found}; false_py = {c: 0 for c in found}; hours = 0.0
for wav in sorted(Path(stream_dir).glob("bed*.wav")):
    p = data[str(wav)][1].astype(np.float32)
    truth = json.loads(wav.with_suffix(".json").read_text())
    hours += len(p) * 0.5 / 3600
    with tempfile.NamedTemporaryFile(suffix=".bin") as tmp:
        tmp.write(p.tobytes()); tmp.flush()
        out = subprocess.run([binary, tmp.name], capture_output=True, text=True).stdout.split("\n")
    fires = {c: [] for c in found}
    for line in out:
        if line.strip():
            name, t, kind = line.split()
            if kind == "heard":
                fires[name].append(float(t))
    for c in found:
        col, (thr, hits) = p[:, classes.index(c)], cfg[c]
        py, run, last = [], 0, -1e9
        for i, v in enumerate(col):
            run = run + 1 if v >= thr else 0
            t = i * 0.5 + 2.0
            if run >= hits and t - last > 30:
                py.append(t); last = t
        events = [e for e in truth if e["sound"] == c]
        for times, f_idx, false in ((fires[c], 0, false_c), (py, 1, false_py)):
            found[c][f_idx] += sum(any(e["start"] - 1 <= t <= e["end"] + 3 for t in times) for e in events)
            false[c] += sum(not any(e["start"] - 1 <= t <= e["end"] + 3 for e in events) for t in times)
        found[c][2] += len(events)
bad = 0
for c, (fc, fp, total) in found.items():
    same = fc == fp and false_c[c] == false_py[c]
    bad += not same
    print(f"{c:16} C: {fc}/{total} found, {false_c[c]} false | python: {fp}/{total}, {false_py[c]} false  {'same' if same else 'DIFFERENT'}")
print(f"{hours:.1f} hours replayed; {'C logic matches the calibration exactly' if not bad else 'MISMATCH'}")
