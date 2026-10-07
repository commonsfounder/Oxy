#!/usr/bin/env python3
"""Quantisation-aware fine-tuning: train the network with 8-bit rounding in the loop so int8 costs (almost) nothing.

  <venv>/bin/python qat.py <EfficientAT repo> <mel folder> <in weights.pt> <out weights.pt> [steps=900] [lr=3e-5]

Batch norm is folded into each convolution first, so what trains is what a chip would run: int8 weights (one scale per
output channel) and int8 layer outputs. The saved weights keep the original network layout (the folded batch norm
becomes a plain bias) with the weights already on the int8 grid; layer-output scales go to <out weights>.scales.json,
which extract.py applies when ACT_SCALES is set. Nothing here is measured on a chip.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

repo, mel_folder, in_weights, out_weights = sys.argv[1], Path(sys.argv[2]), sys.argv[3], sys.argv[4]
steps = int(sys.argv[5]) if len(sys.argv) > 5 else 900
lr = float(sys.argv[6]) if len(sys.argv) > 6 else 3e-5
sys.path.insert(0, repo)
from helpers.utils import NAME_TO_WIDTH  # noqa: E402
from models.mn.model import get_model  # noqa: E402

classes = json.loads((mel_folder / "classes.json").read_text())
model = get_model(width_mult=NAME_TO_WIDTH("mn04_as"), pretrained_name="mn04_as", strides=[2, 2, 2, 2], head_type="mlp")
model.classifier[5] = nn.Linear(model.classifier[5].in_features, len(classes))
model.load_state_dict(torch.load(in_weights, map_location="cpu"))
dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")


def fold_into_conv(net):
    """Conv + BatchNorm -> Conv with the scale baked into its weights; the BatchNorm stays as a fixed per-channel bias."""
    for m in net.modules():
        if isinstance(m, nn.Sequential):
            items = list(m)
            for i in range(len(items) - 1):
                conv, bn = items[i], items[i + 1]
                if isinstance(conv, nn.Conv2d) and isinstance(bn, nn.BatchNorm2d):
                    k = bn.weight.data / torch.sqrt(bn.running_var + bn.eps)
                    conv.weight.data = conv.weight.data * k.view(-1, 1, 1, 1)
                    bn.bias.data = bn.bias.data - bn.running_mean * k
                    bn.weight.data = torch.ones_like(bn.weight.data)
                    bn.running_mean.zero_()
                    bn.running_var.fill_(1.0 - bn.eps)
                    bn.weight.requires_grad_(False)


class FakeQuantWeight(nn.Module):
    def forward(self, w):
        scale = w.detach().abs().amax(dim=tuple(range(1, w.dim())), keepdim=True).clamp(min=1e-8) / 127
        return w + (torch.round(w / scale).clamp(-127, 127) * scale - w).detach()


fold_into_conv(model)
for m in model.modules():
    if isinstance(m, nn.Dropout):
        m.p = 0.0
model.to(dev)
for m in list(model.modules()):
    if isinstance(m, (nn.Conv2d, nn.Linear)):
        torch.nn.utils.parametrize.register_parametrization(m, "weight", FakeQuantWeight())

# Layer-output quantisation: a running estimate of each layer's range (99.9th percentile), then rounding to 8 bits.
scales, frozen = {}, [False]
targets = [(n, m) for n, m in model.named_modules() if isinstance(m, (nn.Conv2d, nn.Linear, nn.Hardswish, nn.ReLU))]


def act_hook(name):
    def hook(module, inputs, output):
        if not frozen[0]:
            sample = output.detach().flatten()[::17].abs().float()
            peak = float(torch.quantile(sample, 0.999)) / 127
            scales[name] = peak if name not in scales else 0.95 * scales[name] + 0.05 * peak
        s = max(scales.get(name, 1e-3), 1e-8)
        q = torch.round(output / s).clamp(-128, 127) * s
        return output + (q - output).detach()
    return hook


for n, m in targets:
    m.register_forward_hook(act_hook(n))

arrays = [np.load(f) for f in sorted(mel_folder.glob("mel-*.npz"))]
X = np.concatenate([a["x"] for a in arrays]); Y = np.concatenate([a["y"] for a in arrays]); SP = np.concatenate([a["split"] for a in arrays])
tr, va = np.where(SP == 0)[0], np.where(SP == 1)[0]
rng = np.random.default_rng(11)
w_class = (len(tr) / (len(classes) * np.bincount(Y[tr], minlength=len(classes)).clip(min=1))) ** 0.5
prob = w_class[Y[tr]] / w_class[Y[tr]].sum()
weights = torch.tensor(w_class, dtype=torch.float32).to(dev)
params = [p for p in model.parameters() if p.requires_grad]
opt = torch.optim.AdamW(params, lr=lr, weight_decay=1e-3)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps, pct_start=0.15)


def bn_eval():
    for m in model.modules():
        if isinstance(m, nn.BatchNorm2d):
            m.eval()


def augment(m):
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
    return correct / len(va)


model.train(); bn_eval()
for _ in range(20):  # settle the range estimates before judging anything
    idx = rng.choice(tr, 64, p=prob)
    with torch.no_grad():
        model(augment(torch.from_numpy(X[idx].astype(np.float32))).unsqueeze(1).to(dev))
print(f"before QAT, with 8-bit rounding: val accuracy {validate():.3f}", flush=True)
best, started = (0.0, None), time.time()
model.train(); bn_eval()
for step in range(steps):
    idx = rng.choice(tr, 64, p=prob)
    xb = augment(torch.from_numpy(X[idx].astype(np.float32))).unsqueeze(1).to(dev)
    loss = torch.nn.functional.cross_entropy(model(xb)[0], torch.from_numpy(Y[idx]).to(dev), weight=weights)
    opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    if step == int(steps * 0.7):
        frozen[0] = True  # last stretch: ranges fixed, so what is evaluated is exactly what is deployed
    if step % 100 == 99 or step == steps - 1:
        model.eval(); accuracy = validate(); model.train(); bn_eval()
        if frozen[0] and accuracy >= best[0]:
            best = (accuracy, {n: float(v) for n, v in scales.items()})
        print(f"step {step + 1}/{steps}: loss {loss.item():.3f}, val accuracy {accuracy:.3f}, {int(time.time() - started)}s", flush=True)

# Bake the rounded weights back into a normal state dict (original layout, weights on the int8 grid).
for m in list(model.modules()):
    if isinstance(m, (nn.Conv2d, nn.Linear)) and hasattr(m, "parametrizations"):
        torch.nn.utils.parametrize.remove_parametrizations(m, "weight", leave_parametrized=True)
torch.save({k: v.detach().cpu() for k, v in model.state_dict().items()}, out_weights)
Path(str(out_weights) + ".scales.json").write_text(json.dumps({n: float(v) for n, v in scales.items()}))
print(f"saved {out_weights}; final val accuracy {validate():.3f} with 8-bit weights and layer outputs")
