#!/usr/bin/env python3
"""Fair, threshold-free comparison of Apple's classifier and our models on the hard-condition test set.

  python3 eval15.py <stress folder> <report.json> --apple <peaks json> [...] --model name=<cache folder>=<classes.json | legacy> [...]

For each sound and each condition the clips of that sound are the positives and every other clip in that condition the
negatives. A model's score for a clip is its highest score in any window (one hit) or the highest score held for two
windows in a row (two hits); each model gets whichever rule suits it better, so nobody is handicapped. Reported:
  recall at 1% false alarms: the share of real examples caught when only 1% of the other clips are allowed to set it off
  AUC: the chance a real example outranks a wrong one (1.0 perfect, 0.5 guessing)
Apple's labels for each sound are listed in APPLE below.
"""
import json
import pickle
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

APPLE = {
    "glass_breaking": ["glass_breaking"], "knock": ["knock"], "doorbell": ["door_bell"], "baby_crying": ["baby_crying"],
    "water_running": ["water_tap_faucet", "sink_filling_washing", "bathtub_filling_washing"], "toilet_flush": ["toilet_flush"],
    "dog_bark": ["dog_bark"], "cough": ["cough"], "scream": ["screaming"], "door_slam": ["door_slam"],
    "gunshot": ["gunshot_gunfire"], "microwave": ["microwave_oven"],
    "siren": ["siren", "police_siren", "ambulance_siren", "fire_engine_siren", "civil_defense_siren", "emergency_vehicle"],
    "phone_ring": ["ringtone", "telephone_bell_ringing"],
}
CONDITIONS = ("clean", "noise10", "noise0", "reverb", "blip1s", "hard")
LEGACY = ["background", "glass_breaking", "knock", "doorbell", "baby_crying"]


def auc(pos, neg):
    pos, neg = np.asarray(pos), np.asarray(neg)
    if not len(pos) or not len(neg):
        return float("nan")
    order = np.argsort(np.concatenate([pos, neg]), kind="stable")
    ranks = np.empty(len(order))
    ranks[order] = np.arange(1, len(order) + 1)
    values = np.concatenate([pos, neg])
    for v in np.unique(values):  # average the ranks of ties
        same = values == v
        if same.sum() > 1:
            ranks[same] = ranks[same].mean()
    return float((ranks[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def recall_at(pos, neg, fpr):
    """Share of positives scoring above the threshold that only `fpr` of the negatives reach."""
    pos, neg = np.asarray(pos), np.asarray(neg)
    if not len(pos) or not len(neg):
        return float("nan")
    threshold = np.sort(neg)[::-1][max(int(np.floor(fpr * len(neg))) - 1, 0)] if fpr * len(neg) >= 1 else np.inf
    return float((pos > threshold).mean()) if np.isfinite(threshold) else float((pos > neg.max()).mean())


def clip_scores(p):
    """p: (windows, classes) -> (one-hit, two-hit) score per class."""
    one = p.max(axis=0)
    two = np.minimum(p[:-1], p[1:]).max(axis=0) if len(p) > 1 else np.zeros(p.shape[1])
    return one, two


def main():
    args = sys.argv[1:]
    stress, report = Path(args[0]), args[1]
    apple_files, models = [], {}
    mode = None
    for a in args[2:]:
        if a == "--apple":
            mode = "apple"
        elif a == "--model":
            mode = "model"
        elif mode == "apple":
            apple_files.append(a)
        else:
            name, folder, classes = a.split("=", 2)
            models[name] = (folder, LEGACY if classes == "legacy" else json.loads(Path(classes).read_text()))
    paths = defaultdict(list)  # condition -> [(path, truth)]
    for condition in CONDITIONS:
        for cls_dir in sorted((stress / condition).iterdir()):
            for wav in sorted(cls_dir.glob("*.wav")):
                paths[condition].append((str(wav), cls_dir.name))

    scores = {}  # model -> path -> {class: (one, two)}
    if apple_files:
        peaks = {}
        for f in apple_files:
            for clip in json.load(open(f)):
                peaks[clip["file"]] = clip
        table = {}
        for path, clip in peaks.items():
            table[path] = {cls: (max(clip["peak1"].get(l, 0) for l in labels), max(clip["peak2"].get(l, 0) for l in labels))
                           for cls, labels in APPLE.items()}
        scores["Apple"] = table
    for name, (folder, classes) in models.items():
        cache = {}
        for f in sorted(Path(folder).glob("eval-*.pkl")):
            cache.update(pickle.load(open(f, "rb")))
        table = {}
        for path, (_, p) in cache.items():
            one, two = clip_scores(p.astype(np.float32))
            table[path] = {cls: (float(one[i]), float(two[i])) for i, cls in enumerate(classes) if cls != "background"}
        scores[name] = table

    sounds = sorted({truth for cond in paths.values() for _, truth in cond} - {"background"})
    result = {}
    for model, table in scores.items():
        for sound in sounds:
            for condition in CONDITIONS:
                clips = [(p, t) for p, t in paths[condition] if p in table and sound in table[p]]
                pos_paths = [p for p, t in clips if t == sound]
                neg_paths = [p for p, t in clips if t != sound]
                if len(pos_paths) < 3 or len(neg_paths) < 20:
                    continue
                best = None
                for rule in (0, 1):
                    pos = [table[p][sound][rule] for p in pos_paths]
                    neg = [table[p][sound][rule] for p in neg_paths]
                    row = {"recall_1": recall_at(pos, neg, 0.01), "recall_5": recall_at(pos, neg, 0.05), "auc": auc(pos, neg),
                           "pos": len(pos), "neg": len(neg), "rule": rule + 1}
                    if best is None or row["recall_1"] + row["auc"] > best["recall_1"] + best["auc"]:
                        best = row
                result[f"{model}|{sound}|{condition}"] = best
    json.dump(result, open(report, "w"), indent=1)

    names = list(scores)
    print(f"{'sound':16} {'test clips':>10}  " + "  ".join(f"{n[:22]:>22}" for n in names))
    print(f"{'':16} {'':>10}  " + "  ".join(f"{'clean/hard  avg  AUC':>22}" for _ in names))
    for sound in sounds:
        cells, n = [], 0
        for model in names:
            def get(cond, key):
                r = result.get(f"{model}|{sound}|{cond}")
                return None if r is None else r[key]
            avg = [get(c, "recall_1") for c in CONDITIONS if get(c, "recall_1") is not None]
            aucs = [get(c, "auc") for c in CONDITIONS if get(c, "auc") is not None]
            if not avg:
                cells.append(f"{'-':>22}")
                continue
            n = max(n, result.get(f"{model}|{sound}|clean", {}).get("pos", 0))
            clean, hard = get("clean", "recall_1"), get("hard", "recall_1")
            cells.append(f"{(clean if clean is not None else float('nan')):.2f}/{(hard if hard is not None else float('nan')):.2f}  {np.mean(avg):.2f}  {np.mean(aucs):.2f}".rjust(22))
        print(f"{sound:16} {n:10}  " + "  ".join(cells))
    print("\nrecall at 1% false alarms; avg = mean over the six conditions; AUC = mean over the six conditions")


if __name__ == "__main__":
    main()
