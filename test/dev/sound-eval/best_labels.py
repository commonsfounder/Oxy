#!/usr/bin/env python3
"""For every ESC-50 sound, finds the Apple label that best picks it out, and what that costs in false alarms.

  python3 best_labels.py <peaks.json from peaks.swift>

Per sound it reports the best label by AUC (1.0 = perfect, 0.5 = guessing), then at the threshold that
catches at least 70% of the 40 clips, how many of the other 1,960 clips it also fires on.
"""
import json
import sys
from collections import defaultdict

clips = json.load(open(sys.argv[1]))
labels = sorted({label for clip in clips for label in clip["peak1"]})
by_category = defaultdict(list)
for index, clip in enumerate(clips):
    by_category[clip["category"]].append(index)


def auc(positive, negative):
    ranked = sorted([(score, 1) for score in positive] + [(score, 0) for score in negative])
    rank_sum, i = 0.0, 0
    while i < len(ranked):
        j = i
        while j < len(ranked) and ranked[j][0] == ranked[i][0]:
            j += 1
        average = (i + j + 1) / 2
        rank_sum += average * sum(flag for _, flag in ranked[i:j])
        i = j
    n_pos, n_neg = len(positive), len(negative)
    return (rank_sum - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


results = []
for category, members in by_category.items():
    member_set = set(members)
    others = [i for i in range(len(clips)) if i not in member_set]
    best = None
    for label in labels:
        positive = [clips[i]["peak1"].get(label, 0) for i in members]
        negative = [clips[i]["peak1"].get(label, 0) for i in others]
        score = auc(positive, negative)
        if best is None or score > best[0]:
            best = (score, label, positive, negative)
    score, label, positive, negative = best
    positive.sort(reverse=True)
    threshold = positive[int(len(positive) * 0.7) - 1]
    false_alarms = sum(1 for value in negative if value >= threshold)
    caught = sum(1 for value in positive if value >= threshold)
    results.append((score, category, label, threshold, caught, len(positive), false_alarms, len(negative)))

print(f"{'sound (ESC-50)':20} {'best Apple label':26} {'AUC':>5}  at-70%-caught: threshold, false alarms")
for score, category, label, threshold, caught, total, false_alarms, negatives in sorted(results, reverse=True):
    print(f"{category:20} {label:26} {score:5.2f}  {threshold:5.2f}  {caught}/{total} caught, {false_alarms}/{negatives} false")
