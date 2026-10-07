#!/usr/bin/env python3
"""What the fine-tuned network would cost on a microcontroller, and what 8-bit numbers do to it.

  <venv>/bin/python budget.py <EfficientAT repo> <weights.pt> <mel folder (finetune.py prep output)>

Counts weights, multiply-adds and activation memory for 2 s of audio, then simulates int8: batch norm folded into the
convolutions, weights rounded to 8 bits per output channel, and every layer's output rounded to 8 bits using a scale
calibrated on training windows. Reports how often the 8-bit version agrees with the full-precision one on validation windows.
This is a simulation on a Mac, not a measurement on the chip.
"""
import copy
import json
import sys
from pathlib import Path

import numpy as np
import torch

repo, weights, mel_folder = sys.argv[1], sys.argv[2], Path(sys.argv[3])
sys.path.insert(0, repo)
from helpers.utils import NAME_TO_WIDTH  # noqa: E402
from models.mn.model import get_model  # noqa: E402

classes = json.loads((mel_folder / "classes.json").read_text()) if (mel_folder / "classes.json").exists() else ["background", "glass_breaking", "knock", "doorbell", "baby_crying"]
model = get_model(width_mult=NAME_TO_WIDTH("mn04_as"), pretrained_name="mn04_as", strides=[2, 2, 2, 2], head_type="mlp")
model.classifier[5] = torch.nn.Linear(512, len(classes))
model.load_state_dict(torch.load(weights, map_location="cpu"))
model.eval()

# ---- cost ----
macs, sizes = [0], []


def count(module, inputs, output):
    if isinstance(module, torch.nn.Conv2d):
        macs[0] += output.numel() * (module.in_channels // module.groups) * module.kernel_size[0] * module.kernel_size[1]
        sizes.append(output.numel())
    elif isinstance(module, torch.nn.Linear):
        macs[0] += module.in_features * module.out_features


handles = [m.register_forward_hook(count) for m in model.modules() if isinstance(m, (torch.nn.Conv2d, torch.nn.Linear))]
with torch.no_grad():
    model(torch.zeros(1, 1, 128, 201))
for h in handles:
    h.remove()
params = sum(p.numel() for p in model.parameters())
pairs = max(a + b for a, b in zip(sizes, sizes[1:]))
print(f"{len(classes)} classes, {params:,} weights = {params / 1e6 * 1.0:.2f} MB as int8 ({params * 4 / 1e6:.2f} MB as float32)")
print(f"{macs[0] / 1e6:.0f} million multiply-adds for each 2 s window; one window every 0.5 s means {macs[0] * 2 / 1e6:.0f} million per second of audio")
print(f"largest single layer output {max(sizes) / 1e3:.0f} KB, two consecutive layers {pairs / 1e3:.0f} KB (int8); BOX-3 has 512 KB fast RAM and 8 MB external")

# ---- int8 simulation ----
arrays = [np.load(f) for f in sorted(mel_folder.glob("mel-*.npz"))]
X = np.concatenate([a["x"] for a in arrays]); Y = np.concatenate([a["y"] for a in arrays]); SP = np.concatenate([a["split"] for a in arrays])
rng = np.random.default_rng(0)
calib = X[rng.choice(np.where(SP == 0)[0], 256, replace=False)].astype(np.float32)
val = X[SP == 1].astype(np.float32)
yv = Y[SP == 1]


def fold(m):
    """Fold every conv+batchnorm pair into the convolution."""
    for child in m.children():
        fold(child)
    if isinstance(m, torch.nn.Sequential):
        mods = list(m)
        for i in range(len(mods) - 1):
            if isinstance(mods[i], torch.nn.Conv2d) and isinstance(mods[i + 1], torch.nn.BatchNorm2d):
                m[i] = torch.nn.utils.fusion.fuse_conv_bn_eval(mods[i], mods[i + 1])
                m[i + 1] = torch.nn.Identity()


def probs(net, x):
    out = []
    with torch.no_grad():
        for i in range(0, len(x), 128):
            out.append(torch.softmax(net(torch.from_numpy(x[i:i + 128]).unsqueeze(1))[0], dim=1).numpy())
    return np.concatenate(out)


fp = copy.deepcopy(model)
fold(fp)
reference = probs(fp, val)

q = copy.deepcopy(fp)
for m in q.modules():  # weights to int8, one scale per output channel
    if isinstance(m, (torch.nn.Conv2d, torch.nn.Linear)):
        w = m.weight.data
        scale = w.abs().amax(dim=tuple(range(1, w.dim())), keepdim=True).clamp(min=1e-8) / 127
        m.weight.data = torch.round(w / scale).clamp(-127, 127) * scale
observed = {}


def observe(name):
    def hook(module, inputs, output):
        observed.setdefault(name, []).append(float(np.percentile(output.detach().abs().numpy(), 99.99)))
    return hook


targets = [(n, m) for n, m in q.named_modules() if isinstance(m, (torch.nn.Conv2d, torch.nn.Linear, torch.nn.Hardswish, torch.nn.ReLU))]
handles = [m.register_forward_hook(observe(n)) for n, m in targets]
probs(q, calib)
for h in handles:
    h.remove()
scales = {n: float(np.mean(v)) / 127 for n, v in observed.items()}


def quantise(name):
    def hook(module, inputs, output):
        s = scales[name]
        return torch.round(output / s).clamp(-128, 127) * s
    return hook


for n, m in targets:
    m.register_forward_hook(quantise(n))
int8 = probs(q, val)
agree = float((int8.argmax(1) == reference.argmax(1)).mean())
acc_fp, acc_q = float((reference.argmax(1) == yv).mean()), float((int8.argmax(1) == yv).mean())
print(f"int8 simulation on {len(val)} validation windows: accuracy {acc_fp:.3f} -> {acc_q:.3f}, same answer as float {agree * 100:.1f}% of the time, mean probability change {np.abs(int8 - reference).mean():.4f}")
