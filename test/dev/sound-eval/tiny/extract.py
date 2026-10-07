#!/usr/bin/env python3
"""Runs an open AudioSet model (EfficientAT) once over our test and training audio and saves what it produced,
so every later experiment (zero-shot scores, fine-tuned heads) reads a file instead of re-running the network.

  <venv>/bin/python extract.py <EfficientAT repo> <model> <eval|train> <stress or soundset_aug folder> <stream folder> <out folder> <shard> <shards>

Per clip it saves, for every 2 s window (hop 0.5 s): the 384-number embedding and the AudioSet scores of the
classes that match our four sounds. Run several shards at once.
"""
import pickle
import sys
from pathlib import Path

import numpy as np
import torch
import torchaudio

repo, name, mode, folder, stream, out, shard, shards = sys.argv[1:9]
shard, shards = int(shard), int(shards)
sys.path.insert(0, repo)
import tiny  # noqa: E402
from helpers.utils import NAME_TO_WIDTH, labels  # noqa: E402
from models.mn.model import get_model  # noqa: E402
import frontend  # noqa: E402

MAP = {"glass_breaking": ["Shatter"], "knock": ["Knock"], "doorbell": ["Doorbell", "Ding-dong"], "baby_crying": ["Baby cry, infant cry"]}
IDS = {cls: [labels.index(n) for n in names] for cls, names in MAP.items()}
import os  # noqa: E402

torch.set_num_threads(2)
model = get_model(width_mult=NAME_TO_WIDTH(name), pretrained_name=name, strides=[2, 2, 2, 2], head_type="mlp")
FT = os.environ.get("FT_WEIGHTS")  # a fine-tuned network (finetune.py): scores become our 5 class probabilities
if FT:
    import json as _json
    model.classifier[5] = torch.nn.Linear(512, len(_json.loads(Path(os.environ["FT_CLASSES"]).read_text())) if os.environ.get("FT_CLASSES") else 5)
    model.load_state_dict(torch.load(FT))
ACT = os.environ.get("ACT_SCALES")  # qat.py output: round every layer's output to 8 bits, as the chip would
if FT and ACT:
    import json as _json2
    _scales = _json2.loads(Path(ACT).read_text())

    def _quant(name):
        def hook(module, inputs, output):
            s = max(_scales[name], 1e-8)
            return torch.round(output / s).clamp(-128, 127) * s
        return hook
    for _n, _m in model.named_modules():
        if _n in _scales:
            _m.register_forward_hook(_quant(_n))
dev = torch.device("mps" if FT and torch.backends.mps.is_available() else "cpu")
model = model.to(dev).eval()
to_mel = frontend.make()
SECONDS = 2.0
WIN = int(SECONDS * 16000)


def run(windows16):
    """(n, WIN) 16 kHz windows -> embeddings (n,384), mapped scores (n,4), both float16."""
    embs, scores = [], []
    with torch.no_grad():
        for i in range(0, len(windows16), 128):
            w = torch.from_numpy(windows16[i:i + 128])
            preds, features = model(to_mel(w).unsqueeze(1).to(dev))
            if FT:
                p = torch.softmax(preds.float(), dim=1).cpu().numpy()
                scores.append(p)
            else:
                p = torch.sigmoid(preds.float()).cpu().numpy()
                scores.append(np.stack([p[:, ids].max(axis=1) for ids in IDS.values()], axis=1))
            embs.append(features.reshape(len(w), -1).cpu().numpy())
    return np.concatenate(embs).astype(np.float16), np.concatenate(scores).astype(np.float16)


def eval_windows(x):
    if len(x) < WIN:
        x = np.concatenate([x, np.zeros(WIN - len(x), dtype=np.float32)])
    return np.stack([x[s:s + WIN] for s in range(0, len(x) - WIN + 1, 8000)]).astype(np.float32)


def train_windows(x, is_target, rng):
    if len(x) < WIN:
        x = np.concatenate([x, rng.standard_normal(WIN - len(x)).astype(np.float32) * 1e-4])
    if len(x) == WIN:
        return x[None].astype(np.float32)
    sums = np.concatenate([[0.0], np.cumsum(np.square(x), dtype=np.float64)])
    best = int((sums[WIN:] - sums[:-WIN]).argmax())
    starts = {best, max(0, best - 8000), min(len(x) - WIN, best + 8000)} if is_target else {int(rng.integers(0, len(x) - WIN + 1)) for _ in range(3)}
    return np.stack([x[s:s + WIN] for s in sorted(starts)]).astype(np.float32)


import tiny as t  # noqa: E402,F811
audio = t.audio
jobs = []
if mode == "eval":
    for condition in ("clean", "noise10", "noise0", "reverb", "blip1s", "hard"):
        jobs += sorted((Path(folder) / condition).rglob("*.wav"))
    jobs += sorted(Path(stream).glob("bed*.wav"))
else:
    for split in ("train", "val"):
        jobs += sorted((Path(folder) / split).rglob("*.wav"))
jobs = [p for i, p in enumerate(jobs) if i % shards == shard]
result, rng = {}, np.random.default_rng(shard)
for n, path in enumerate(jobs):
    x = audio.load(path)
    if x is None:
        continue
    if mode == "eval":
        emb, sc = run(eval_windows(x))
        result[str(path)] = (emb, sc)
    else:
        cls = path.parent.name
        emb, sc = run(train_windows(x, cls != "background", rng))
        result[str(path)] = (emb, sc)
    if n % 100 == 99:
        print(f"shard {shard}: {n + 1}/{len(jobs)}", flush=True)
Path(out).mkdir(parents=True, exist_ok=True)
with open(Path(out) / f"{mode}-{shard}.pkl", "wb") as f:
    pickle.dump(result, f)
print(f"shard {shard} done: {len(result)} clips", flush=True)
