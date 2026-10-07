#!/usr/bin/env python3
"""Fine-tune the WHOLE EfficientAT network (not just a head) on our sounds.

  <venv>/bin/python finetune.py prep  <EfficientAT repo> <soundset_aug folder> <out folder> <shard> <shards>
  <venv>/bin/python finetune.py bench <EfficientAT repo> <mel folder>
  <venv>/bin/python finetune.py train <EfficientAT repo> <mel folder> <out weights.pt> [steps=1800] [lr=3e-4]

prep: cuts the same 2 s training windows as extract.py and stores their mel spectrograms (so training never repeats that work).
train: starts from the AudioSet weights, swaps the last layer for our 5 classes, trains everything with a lower rate for the body.
"""
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torchaudio

mode, repo = sys.argv[1], sys.argv[2]
sys.path.insert(0, repo)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import tiny  # noqa: E402
from helpers.utils import NAME_TO_WIDTH  # noqa: E402
from models.mn.model import get_model  # noqa: E402
from models.preprocess import AugmentMelSTFT  # noqa: E402

CLASSES = tiny.CLASSES
WIN = 32000  # 2 s at 16 kHz


def train_windows(x, is_target, rng):
    if len(x) < WIN:
        x = np.concatenate([x, rng.standard_normal(WIN - len(x)).astype(np.float32) * 1e-4])
    if len(x) == WIN:
        return x[None].astype(np.float32)
    sums = np.concatenate([[0.0], np.cumsum(np.square(x), dtype=np.float64)])
    best = int((sums[WIN:] - sums[:-WIN]).argmax())
    starts = {best, max(0, best - 8000), min(len(x) - WIN, best + 8000)} if is_target else {int(rng.integers(0, len(x) - WIN + 1)) for _ in range(3)}
    return np.stack([x[s:s + WIN] for s in sorted(starts)]).astype(np.float32)


def build():
    model = get_model(width_mult=NAME_TO_WIDTH("mn04_as"), pretrained_name="mn04_as", strides=[2, 2, 2, 2], head_type="mlp")
    model.classifier[5] = torch.nn.Linear(512, len(CLASSES))
    return model


if mode == "prep":
    folder, out, shard, shards = Path(sys.argv[3]), Path(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
    torch.set_num_threads(2)
    mel = AugmentMelSTFT(n_mels=128, sr=32000, win_length=800, hopsize=320).eval()
    jobs = [p for split in ("train", "val") for p in sorted((folder / split).rglob("*.wav"))]
    jobs = [p for i, p in enumerate(jobs) if i % shards == shard]
    rng = np.random.default_rng(shard)
    xs, ys, sp = [], [], []
    for n, path in enumerate(jobs):
        x = tiny.audio.load(path)
        if x is None:
            continue
        w = train_windows(x, path.parent.name != "background", rng)
        with torch.no_grad():
            m = mel(torchaudio.functional.resample(torch.from_numpy(w), 16000, 32000))
        xs.append(m.numpy().astype(np.float16))
        ys += [CLASSES.index(path.parent.name)] * len(w)
        sp += [1 if path.parent.parent.name == "val" else 0] * len(w)
        if n % 500 == 499:
            print(f"shard {shard}: {n + 1}/{len(jobs)}", flush=True)
    out.mkdir(parents=True, exist_ok=True)
    np.savez(out / f"mel-{shard}.npz", x=np.concatenate(xs), y=np.array(ys), split=np.array(sp))
    print(f"shard {shard} done", flush=True)
    sys.exit()

folder = Path(sys.argv[3])
arrays = [np.load(f) for f in sorted(folder.glob("mel-*.npz"))]
X = np.concatenate([a["x"] for a in arrays]); Y = np.concatenate([a["y"] for a in arrays]); SP = np.concatenate([a["split"] for a in arrays])
tr, va = np.where(SP == 0)[0], np.where(SP == 1)[0]
print(f"{len(tr)} train windows {np.bincount(Y[tr]).tolist()}, {len(va)} val windows, mel {X.shape[1:]}", flush=True)
torch.set_num_threads(10)
dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
model = build().to(dev)
batch = 64

if mode == "bench":
    model.train()
    opt = torch.optim.AdamW(model.parameters(), lr=1e-4)
    xb = torch.from_numpy(X[tr[:batch]].astype(np.float32)).unsqueeze(1).to(dev)
    yb = torch.from_numpy(Y[tr[:batch]]).to(dev)
    for i in range(4):
        t = time.time()
        loss = torch.nn.functional.cross_entropy(model(xb)[0], yb)
        opt.zero_grad(); loss.backward(); opt.step()
        print(f"step {i}: {time.time() - t:.2f}s for {batch} windows", flush=True)
    sys.exit()

out = sys.argv[4]
steps = int(sys.argv[5]) if len(sys.argv) > 5 else 1800
lr = float(sys.argv[6]) if len(sys.argv) > 6 else 3e-4
rng = np.random.default_rng(5)
w_class = (len(tr) / (len(CLASSES) * np.bincount(Y[tr]))) ** 0.5
prob = w_class[Y[tr]] / w_class[Y[tr]].sum()
body = [p for n, p in model.named_parameters() if not n.startswith("classifier.5")]
opt = torch.optim.AdamW([{"params": body, "lr": lr / 4}, {"params": model.classifier[5].parameters(), "lr": lr}], weight_decay=1e-2)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=[lr / 4, lr], total_steps=steps, pct_start=0.1)
weights = torch.tensor(w_class, dtype=torch.float32).to(dev)


def augment(m):
    """m: (B,128,T) normalised log-mel. Shift in time, mask a band and a stretch, nudge the level."""
    for i in range(len(m)):
        m[i] = torch.roll(m[i], int(rng.integers(-15, 16)), dims=1)
        f = int(rng.integers(0, 17)); f0 = int(rng.integers(0, 128 - f)); m[i, f0:f0 + f] = 0
        t = int(rng.integers(0, 21)); t0 = int(rng.integers(0, m.shape[2] - t)); m[i, :, t0:t0 + t] = 0
    return m + torch.randn(len(m), 1, 1) * 0.3


def validate():
    model.eval()
    correct = 0
    with torch.no_grad():
        for i in range(0, len(va), 128):
            idx = va[i:i + 128]
            logits = model(torch.from_numpy(X[idx].astype(np.float32)).unsqueeze(1).to(dev))[0]
            correct += int((logits.argmax(1).cpu().numpy() == Y[idx]).sum())
    model.train()
    return correct / len(va)


best, started = (0.0, None), time.time()
model.train()
for step in range(steps):
    idx = rng.choice(tr, batch, p=prob)
    xb = augment(torch.from_numpy(X[idx].astype(np.float32))).unsqueeze(1).to(dev)
    loss = torch.nn.functional.cross_entropy(model(xb)[0], torch.from_numpy(Y[idx]).to(dev), weight=weights)
    opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    if step % 100 == 99 or step == steps - 1:
        accuracy = validate()
        if accuracy > best[0]:
            best = (accuracy, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()})
            torch.save(best[1], out)
        print(f"step {step + 1}/{steps}: loss {loss.item():.3f}, val accuracy {accuracy:.3f} (best {best[0]:.3f}), {int(time.time() - started)}s", flush=True)
print(f"done, best val accuracy {best[0]:.3f}")
