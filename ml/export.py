"""Exports a trained checkpoint to ONNX for docdiet (onnxruntime-node) and checks that
onnxruntime gives the same answers as PyTorch.

    ml/.venv/bin/python ml/export.py --model ml/runs/model-varied2.pt

The exported graph takes what docdiet can produce without PyTorch: grayscale pages already
resized to 224×320, pixel values 0-255, shape [pages, 1, 320, 224]. Everything the training
pipeline did after that (3 channels, ImageNet normalization) and the final sigmoid live inside
the graph, so Node only has to render and resize.
"""

import argparse
from pathlib import Path

import numpy as np
import onnxruntime
import torch
from torch import nn

from generate import IMG_H, IMG_W
from train import LABELS, ML_DIR, build_model

MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]


class PageClassifier(nn.Module):
    """Raw grayscale pixels in, one probability per label out."""

    def __init__(self, model: nn.Module):
        super().__init__()
        self.model = model
        self.register_buffer("mean", torch.tensor(MEAN).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(STD).view(1, 3, 1, 1))

    def forward(self, gray):
        rgb = (gray / 255.0).expand(-1, 3, -1, -1)
        return torch.sigmoid(self.model((rgb - self.mean) / self.std))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=ML_DIR / "runs" / "model-varied2.pt")
    parser.add_argument("--out", type=Path, default=ML_DIR.parent / "models" / "page-classifier.onnx")
    args = parser.parse_args()

    model = build_model()
    model.load_state_dict(torch.load(args.model, map_location="cpu"))
    wrapped = PageClassifier(model).eval()

    sample = torch.randint(0, 256, (4, 1, IMG_H, IMG_W)).float()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        wrapped,
        (sample,),
        args.out,
        input_names=["pages"],
        output_names=["probabilities"],
        dynamic_axes={"pages": {0: "n"}, "probabilities": {0: "n"}},
        opset_version=17,
        dynamo=False,
    )

    with torch.no_grad():
        expected = wrapped(sample).numpy()
    session = onnxruntime.InferenceSession(str(args.out))
    actual = session.run(None, {"pages": sample.numpy()})[0]
    diff = np.abs(expected - actual).max()
    print(f"{args.out} ({args.out.stat().st_size / 1e6:.1f} MB), labels {LABELS}, max |torch - onnx| = {diff:.2e}")
    assert diff < 1e-4, "ONNX output differs from PyTorch"


if __name__ == "__main__":
    main()
