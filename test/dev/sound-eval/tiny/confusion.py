import json, sys, numpy as np, torch
sys.path.insert(0, ".")
from helpers.utils import NAME_TO_WIDTH
from models.mn.model import get_model
from pathlib import Path
classes = json.loads(Path(sys.argv[2]).read_text())
m = get_model(width_mult=NAME_TO_WIDTH("mn04_as"), pretrained_name="mn04_as", strides=[2,2,2,2], head_type="mlp")
m.classifier[5] = torch.nn.Linear(m.classifier[5].in_features, len(classes))
m.load_state_dict(torch.load(sys.argv[1], map_location="cpu")); m.eval()
dev = torch.device("mps"); m.to(dev)
conf = np.zeros((len(classes), len(classes)), dtype=int)
for f in sorted(Path(sys.argv[3]).glob("mel-*.npz")):
    a = np.load(f); val = a["split"] == 1
    x, y = a["x"][val].astype(np.float32), a["y"][val]
    with torch.no_grad():
        for i in range(0, len(x), 128):
            p = m(torch.from_numpy(x[i:i+128]).unsqueeze(1).to(dev))[0].argmax(1).cpu().numpy()
            for t, q in zip(y[i:i+128], p): conf[t, q] += 1
print("per-class recall on validation windows, and the three things each is most often mistaken for")
for i, c in enumerate(classes):
    row = conf[i]; n = row.sum()
    top = [(classes[j], int(row[j])) for j in np.argsort(-row) if j != i][:3]
    print(f"{c:15} n={n:4} recall {row[i]/max(n,1):.2f}  confused with: " + ", ".join(f"{k} {v}" for k, v in top))
print("overall", conf.trace() / conf.sum())
