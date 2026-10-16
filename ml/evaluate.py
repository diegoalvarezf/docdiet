"""Measures a trained model on a folder of labelled pages.

Accuracy alone hides a lot when a label is rare, so it also reports precision (when it says
"table", how often is there one?) and recall (of the real tables, how many did it find?).

    ml/.venv/bin/python ml/evaluate.py --data ml/data/real
"""

import argparse
import csv
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from train import LABELS, ML_DIR, Pages, build_model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=ML_DIR / "data" / "real")
    parser.add_argument("--model", type=Path, default=ML_DIR / "runs" / "model.pt")
    parser.add_argument("--errors", type=Path, help="write misclassified pages to this CSV")
    args = parser.parse_args()

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dataset = Pages(args.data, train=False)
    model = build_model()
    model.load_state_dict(torch.load(args.model, map_location="cpu"))
    model.to(device).eval()

    probs, targets = [], []
    with torch.no_grad():
        for images, target in DataLoader(dataset, batch_size=64):
            probs.append(torch.sigmoid(model(images.to(device))).cpu())
            targets.append(target)
    probs, targets = torch.cat(probs), torch.cat(targets)
    predicted = (probs > 0.5).float()

    print(f"{len(dataset)} pages from {args.data}\n")
    print(f"{'label':<12} {'accuracy':>9} {'precision':>10} {'recall':>8}   (positives: real / predicted)")
    for i, name in enumerate(LABELS):
        p, t = predicted[:, i], targets[:, i]
        tp = (p * t).sum().item()
        accuracy = (p == t).float().mean().item()
        precision = tp / p.sum().item() if p.sum() else float("nan")
        recall = tp / t.sum().item() if t.sum() else float("nan")
        print(f"{name:<12} {accuracy:>9.1%} {precision:>10.1%} {recall:>8.1%}   ({int(t.sum())} / {int(p.sum())})")

    if args.errors:
        with open(args.errors, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["file", "label", "truth", "probability"])
            for row, prob, target in zip(dataset.rows, probs, targets):
                for i, name in enumerate(LABELS):
                    if (prob[i] > 0.5) != bool(target[i]):
                        writer.writerow([row["file"], name, int(target[i]), f"{prob[i]:.2f}"])
        print(f"\nerrors -> {args.errors}")


if __name__ == "__main__":
    main()
