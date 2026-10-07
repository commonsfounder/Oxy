#!/usr/bin/env python3
"""A from-scratch household sound model small enough for the BOX-3, in plain numpy (no ML library).

Input: 1 s of 16 kHz audio -> 32 mel bands x 32 time steps of log energy, with each band's typical level over
the window subtracted (so a steady background and the microphone's loudness drop out). Model: 1024 -> 64 -> 32 -> 5,
about 68k weights, 68 KB as int8. Same classes and data as the phone model: glass_breaking, knock, doorbell,
baby_crying, background.

  python3 tiny.py train <soundset_aug folder> <out model.npz>
  python3 tiny.py eval <model.npz> <stress folder> <stream folder>
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "train"))
import audiolib as audio  # noqa: E402

CLASSES = ["background", "glass_breaking", "knock", "doorbell", "baby_crying"]
WIN, NFFT, HOP, NMEL, POOL = 16000, 512, 160, 32, 3
FRAMES = ((WIN - NFFT) // HOP + 1) // POOL  # 32


def mel_filters():
    def to_mel(f): return 2595 * np.log10(1 + f / 700)
    def to_hz(m): return 700 * (10 ** (m / 2595) - 1)
    points = to_hz(np.linspace(to_mel(50), to_mel(7600), NMEL + 2))
    bins = np.floor((NFFT + 1) * points / audio.RATE).astype(int)
    bank = np.zeros((NMEL, NFFT // 2 + 1), dtype=np.float32)
    for m in range(NMEL):
        lo, mid, hi = bins[m], bins[m + 1], bins[m + 2]
        bank[m, lo:mid] = (np.arange(lo, mid) - lo) / max(mid - lo, 1)
        bank[m, mid:hi] = (hi - np.arange(mid, hi)) / max(hi - mid, 1)
    return bank


BANK, HANN = mel_filters(), np.hanning(NFFT).astype(np.float32)


def features(windows):
    """(N, 16000) audio -> (N, 1024) features. Chunked to keep memory small."""
    out = []
    for start in range(0, len(windows), 128):
        chunk = windows[start:start + 128].astype(np.float32)
        frames = np.lib.stride_tricks.sliding_window_view(chunk, NFFT, axis=1)[:, ::HOP] * HANN
        power = np.abs(np.fft.rfft(frames, axis=2)) ** 2
        mel = np.log(power @ BANK.T + 1e-7)
        mel = mel[:, :FRAMES * POOL].reshape(len(chunk), FRAMES, POOL, NMEL).mean(axis=2)
        mel -= np.median(mel, axis=1, keepdims=True)
        out.append(mel.reshape(len(chunk), -1))
    return np.concatenate(out) if out else np.zeros((0, FRAMES * NMEL), dtype=np.float32)


def pad(x):
    return x if len(x) >= WIN else np.concatenate([x, np.random.default_rng(0).standard_normal(WIN - len(x)).astype(np.float32) * 1e-4])


def all_windows(x, hop=WIN // 2):
    x = pad(x)
    return np.stack([x[s:s + WIN] for s in range(0, len(x) - WIN + 1, hop)])


def training_windows(x, is_target, rng):
    x = pad(x)
    if len(x) == WIN:
        return x[None]
    sums = np.concatenate([[0.0], np.cumsum(np.square(x), dtype=np.float64)])
    energy = sums[WIN:] - sums[:-WIN]
    best = int(energy.argmax())
    if is_target:
        starts = {best, max(0, best - 4000), min(len(x) - WIN, best + 4000)}
    else:
        starts = {int(rng.integers(0, len(x) - WIN + 1)) for _ in range(3)}
    return np.stack([x[s:s + WIN] for s in sorted(starts)])


def load_split(folder, rng):
    xs, ys = [], []
    for index, cls in enumerate(CLASSES):
        for path in sorted((folder / cls).glob("*.wav")):
            x = audio.load(path)
            if x is None or len(x) < WIN // 4:
                continue
            w = training_windows(x, cls != "background", rng)
            xs.append(features(w))
            ys += [index] * len(w)
    return np.concatenate(xs), np.array(ys)


def forward(params, x, drop=0.0, rng=None):
    w1, b1, w2, b2, w3, b3 = params
    h1 = np.maximum(x @ w1 + b1, 0)
    mask = None
    if drop:
        mask = (rng.random(h1.shape) > drop) / (1 - drop)
        h1 = h1 * mask
    h2 = np.maximum(h1 @ w2 + b2, 0)
    z = h2 @ w3 + b3
    z -= z.max(axis=1, keepdims=True)
    p = np.exp(z)
    return p / p.sum(axis=1, keepdims=True), (x, h1, h2, mask)


def train(folder, out):
    rng = np.random.default_rng(3)
    x, y = load_split(Path(folder) / "train", rng)
    xv, yv = load_split(Path(folder) / "val", rng)
    mean, std = x.mean(axis=0), x.std(axis=0) + 1e-3
    x, xv = (x - mean) / std, (xv - mean) / std
    print(f"{len(x)} train windows, {len(xv)} val windows, per class {np.bincount(y).tolist()}")
    sizes = [x.shape[1], 64, 32, len(CLASSES)]
    params = []
    for a_, b_ in zip(sizes[:-1], sizes[1:]):
        params += [(rng.standard_normal((a_, b_)) * np.sqrt(2 / a_)).astype(np.float32), np.zeros(b_, dtype=np.float32)]
    weights = (len(y) / (len(CLASSES) * np.bincount(y))) ** 0.5
    m = [np.zeros_like(p) for p in params]
    v = [np.zeros_like(p) for p in params]
    step, best = 0, (0, None)
    for epoch in range(40):
        lr = 2e-3 * (0.5 * (1 + np.cos(np.pi * epoch / 40)) * 0.95 + 0.05)
        order = rng.permutation(len(x))
        for s in range(0, len(x), 256):
            idx = order[s:s + 256]
            xb = x[idx]
            shift = int(rng.integers(-2, 3))
            if shift:
                xb = np.roll(xb.reshape(len(idx), FRAMES, NMEL), shift, axis=1).reshape(len(idx), -1)
            xb = xb + rng.standard_normal(xb.shape).astype(np.float32) * 0.05
            p, (xin, h1, h2, mask) = forward(params, xb, 0.2, rng)
            g = p.copy()
            g[np.arange(len(idx)), y[idx]] -= 1
            g *= weights[y[idx]][:, None] / len(idx)
            w1, b1, w2, b2, w3, b3 = params
            gw3, gb3 = h2.T @ g, g.sum(0)
            g2 = (g @ w3.T) * (h2 > 0)
            gw2, gb2 = h1.T @ g2, g2.sum(0)
            g1 = (g2 @ w2.T) * (h1 > 0) * mask
            grads = [xin.T @ g1, g1.sum(0), gw2, gb2, gw3, gb3]
            step += 1
            for i, grad in enumerate(grads):
                m[i] = 0.9 * m[i] + 0.1 * grad
                v[i] = 0.999 * v[i] + 0.001 * grad * grad
                params[i] -= lr * (m[i] / (1 - 0.9 ** step)) / (np.sqrt(v[i] / (1 - 0.999 ** step)) + 1e-8)
        pv, _ = forward(params, xv)
        accuracy = float((pv.argmax(1) == yv).mean())
        if accuracy > best[0]:
            best = (accuracy, [p.copy() for p in params])
        if epoch % 5 == 4 or epoch == 39:
            print(f"epoch {epoch + 1}: val accuracy {accuracy:.3f}")
    print(f"best val accuracy {best[0]:.3f}")
    np.savez(out, mean=mean, std=std, *best[1])


RULES = {"glass_breaking": 1, "knock": 1, "doorbell": 1, "baby_crying": 2}


def load_model(path):
    d = np.load(path)
    return d["mean"], d["std"], [d[f"arr_{i}"] for i in range(6)]


def probabilities(model, x):
    mean, std, params = model
    p, _ = forward(params, (features(all_windows(x)) - mean) / std)
    return p


def fires(p, cls, threshold, hits):
    run = 0
    for row in p[:, CLASSES.index(cls)]:
        run = run + 1 if row >= threshold else 0
        if run >= hits:
            return True
    return False


def evaluate(model_path, stress, stream):
    model = load_model(model_path)
    for condition in ("clean", "noise10", "noise0", "reverb", "blip1s", "hard"):
        clips = []
        for cls in CLASSES:
            for path in sorted((Path(stress) / condition / cls).glob("*.wav")):
                x = audio.load(path)
                if x is not None:
                    clips.append((cls, probabilities(model, x)))
        print(f"\n{condition} ({len(clips)} clips)")
        for threshold in (0.5, 0.8, 0.95):
            cells = []
            for cls, hits in RULES.items():
                pos = [p for c, p in clips if c == cls]
                neg = [p for c, p in clips if c != cls]
                caught = sum(fires(p, cls, threshold, hits) for p in pos)
                false = sum(fires(p, cls, threshold, hits) for p in neg)
                cells.append(f"{cls[:5]} {caught}/{len(pos)} ({false})")
            print(f"  threshold {threshold}: " + "  ".join(cells))
    print("\nstream (10-minute beds, sounds dropped in)")
    beds = sorted(Path(stream).glob("bed*.wav"))
    probs = [(probabilities(model, audio.load(b)), json.loads(b.with_suffix(".json").read_text())) for b in beds]
    total = {c: sum(e["sound"] == c for _, truth in probs for e in truth) for c in RULES}
    hours = sum(len(p) * 0.5 for p, _ in probs) / 3600
    for threshold in (0.8, 0.95):
        cells = []
        for cls, hits in RULES.items():
            found, falses = 0, 0
            for p, truth in probs:
                col, run, last, times = p[:, CLASSES.index(cls)], 0, -99, []
                for i, value in enumerate(col):
                    run = run + 1 if value >= threshold else 0
                    t = i * 0.5 + 1.0
                    if run >= hits and t - last > 30:
                        times.append(t)
                        last = t
                events = [e for e in truth if e["sound"] == cls]
                found += sum(any(e["start"] - 1 <= t <= e["end"] + 3 for t in times) for e in events)
                falses += sum(not any(e["start"] - 1 <= t <= e["end"] + 3 for e in events) for t in times)
            cells.append(f"{cls[:5]} {found}/{total[cls]} ({falses / hours:.0f}/h)")
        print(f"  threshold {threshold}: " + "  ".join(cells))


if __name__ == "__main__":
    if sys.argv[1] == "train":
        train(sys.argv[2], sys.argv[3])
    else:
        evaluate(sys.argv[2], sys.argv[3], sys.argv[4])
