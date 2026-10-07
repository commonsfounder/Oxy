#!/usr/bin/env python3
"""Fine-tune a small head on EfficientAT embeddings (extract.py output), and score it from the saved cache.

  <venv>/bin/python head.py train <emb folder> <out head.pt>
  <venv>/bin/python head.py eval <emb folder> <stress> <stream> [head.pt | zeroshot]
"""
import pickle
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tiny  # noqa: E402

CLASSES = tiny.CLASSES


def load(folder, mode):
    data = {}
    for f in sorted(Path(folder).glob(f"{mode}-*.pkl")):
        data.update(pickle.load(open(f, "rb")))
    return data


def train(folder, out):
    torch.manual_seed(1)
    data = load(folder, "train")
    X = {"train": [], "val": []}
    Y = {"train": [], "val": []}
    for path, (emb, _) in data.items():
        p = Path(path)
        split = "val" if p.parent.parent.name == "val" else "train"
        X[split].append(emb.astype(np.float32))
        Y[split] += [CLASSES.index(p.parent.name)] * len(emb)
    xt, yt = np.concatenate(X["train"]), np.array(Y["train"])
    xv, yv = np.concatenate(X["val"]), np.array(Y["val"])
    mean, std = xt.mean(0), xt.std(0) + 1e-3
    xt, xv = (xt - mean) / std, (xv - mean) / std
    print(f"{len(xt)} train windows {np.bincount(yt).tolist()}, {len(xv)} val windows")
    net = torch.nn.Sequential(torch.nn.Linear(384, 128), torch.nn.ReLU(), torch.nn.Dropout(0.3), torch.nn.Linear(128, len(CLASSES)))
    weights = torch.tensor((len(yt) / (len(CLASSES) * np.bincount(yt))) ** 0.5, dtype=torch.float32)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-2)
    xt_t, yt_t, xv_t = torch.from_numpy(xt), torch.from_numpy(yt), torch.from_numpy(xv)
    best = (0, None)
    for epoch in range(60):
        net.train()
        order = torch.randperm(len(xt_t))
        for i in range(0, len(order), 256):
            idx = order[i:i + 256]
            xb = xt_t[idx] + torch.randn(len(idx), 384) * 0.1
            loss = torch.nn.functional.cross_entropy(net(xb), yt_t[idx], weight=weights)
            opt.zero_grad(); loss.backward(); opt.step()
        net.eval()
        with torch.no_grad():
            accuracy = float((net(xv_t).argmax(1).numpy() == yv).mean())
        if accuracy > best[0]:
            best = (accuracy, {k: v.clone() for k, v in net.state_dict().items()})
        if epoch % 10 == 9:
            print(f"epoch {epoch + 1}: val accuracy {accuracy:.3f}")
    print(f"best val accuracy {best[0]:.3f}")
    torch.save({"net": best[1], "mean": mean, "std": std}, out)


def evaluate(folder, stress, stream, which):
    cache = load(folder, "eval")
    tiny.STREAM_WINDOW = 2.0
    if which == "zeroshot":
        def prob_fn(path):
            entry = cache.get(str(path))
            if entry is None:
                return None
            p = np.zeros((len(entry[1]), len(CLASSES)), dtype=np.float32)
            p[:, 1:] = entry[1].astype(np.float32)
            return p
        thresholds = (0.1, 0.3, 0.5)
    else:
        saved = torch.load(which, weights_only=False)
        net = torch.nn.Sequential(torch.nn.Linear(384, 128), torch.nn.ReLU(), torch.nn.Dropout(0.3), torch.nn.Linear(128, len(CLASSES)))
        net.load_state_dict(saved["net"]); net.eval()

        def prob_fn(path):
            entry = cache.get(str(path))
            if entry is None:
                return None
            with torch.no_grad():
                x = torch.from_numpy(((entry[0].astype(np.float32) - saved["mean"]) / saved["std"]))
                return torch.softmax(net(x), dim=1).numpy()
        thresholds = (0.5, 0.8, 0.95)
    tiny.evaluate(None, stress, stream, thresholds=thresholds, prob_fn=prob_fn)


if __name__ == "__main__":
    if sys.argv[1] == "train":
        train(sys.argv[2], sys.argv[3])
    else:
        evaluate(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] if len(sys.argv) > 5 else "zeroshot")
