"""Fine-tunes a small pretrained CNN to tell, from a page image, whether it has a table,
a figure and two columns (three independent yes/no answers: multi-label classification).

    ml/.venv/bin/python ml/train.py --epochs 5
"""

import argparse
import csv
import time
from pathlib import Path

import torch
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

LABELS = ["table", "figure", "two_columns"]
ML_DIR = Path(__file__).parent

# The pretrained network learned on ImageNet photos normalized with these values.
NORMALIZE = transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])


class Pages(Dataset):
    def __init__(self, split_dir: Path, train: bool):
        with open(split_dir / "labels.csv") as f:
            self.rows = list(csv.DictReader(f))
        self.dir = split_dir
        steps = [transforms.Grayscale(num_output_channels=3)]
        if train:
            # Small random shifts and contrast changes so it can't memorize exact pixels.
            steps += [transforms.RandomAffine(degrees=1, translate=(0.03, 0.03), scale=(0.95, 1.05), fill=255),
                      transforms.ColorJitter(brightness=0.2, contrast=0.2)]
        steps += [transforms.ToTensor(), NORMALIZE]
        self.transform = transforms.Compose(steps)

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        row = self.rows[i]
        image = self.transform(Image.open(self.dir / row["file"]))
        target = torch.tensor([float(row[k]) for k in LABELS])
        return image, target


def build_model() -> nn.Module:
    model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.DEFAULT)
    # Keep everything it learned about edges, shapes and textures; replace only the last layer,
    # which answered "which of 1000 ImageNet classes?", with our 3 yes/no outputs.
    model.classifier[-1] = nn.Linear(model.classifier[-1].in_features, len(LABELS))
    return model


@torch.no_grad()
def evaluate(model, loader, device, loss_fn):
    model.eval()
    total_loss, correct, count = 0.0, torch.zeros(len(LABELS)), 0
    for images, targets in loader:
        images, targets = images.to(device), targets.to(device)
        logits = model(images)
        total_loss += loss_fn(logits, targets).item() * len(images)
        predictions = (torch.sigmoid(logits) > 0.5).float()
        correct += (predictions == targets).sum(dim=0).cpu()
        count += len(images)
    return total_loss / count, correct / count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=ML_DIR / "data" / "synth")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--out", type=Path, default=ML_DIR / "runs" / "model.pt")
    args = parser.parse_args()

    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    train_loader = DataLoader(Pages(args.data / "train", train=True), batch_size=args.batch, shuffle=True, num_workers=4)
    val_loader = DataLoader(Pages(args.data / "val", train=False), batch_size=args.batch, num_workers=4)

    model = build_model().to(device)
    # Sigmoid + binary cross-entropy per label: each output is its own yes/no question.
    loss_fn = nn.BCEWithLogitsLoss()
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)

    print(f"device={device} train={len(train_loader.dataset)} val={len(val_loader.dataset)}")
    best = float("inf")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    for epoch in range(1, args.epochs + 1):
        start = time.time()
        model.train()
        running = 0.0
        for images, targets in train_loader:
            images, targets = images.to(device), targets.to(device)
            optimizer.zero_grad()
            loss = loss_fn(model(images), targets)
            loss.backward()
            optimizer.step()
            running += loss.item() * len(images)
        scheduler.step()

        train_loss = running / len(train_loader.dataset)
        val_loss, accuracy = evaluate(model, val_loader, device, loss_fn)
        acc = "  ".join(f"{k} {a:.1%}" for k, a in zip(LABELS, accuracy.tolist()))
        print(f"epoch {epoch}: train loss {train_loss:.4f}  val loss {val_loss:.4f}  |  {acc}  ({time.time() - start:.0f}s)")
        if val_loss < best:
            best = val_loss
            torch.save(model.state_dict(), args.out)
    print(f"best val loss {best:.4f} -> {args.out}")


if __name__ == "__main__":
    main()
