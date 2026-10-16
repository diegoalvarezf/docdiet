"""Turns DocLayNet-small (real pages, human annotations) into our format: page images rendered
exactly like the synthetic ones, plus table / figure / two_columns labels.

table and figure come straight from the annotations. two_columns is derived from where the
text boxes sit, so it is an approximation.

    ml/.venv/bin/python ml/prepare_doclaynet.py
"""

import csv
import json
import random
from pathlib import Path

import pymupdf

from generate import IMG_H, IMG_W

ML_DIR = Path(__file__).parent
SOURCE = ML_DIR / "data" / "doclaynet" / "small_dataset"
OUT = ML_DIR / "data" / "real"
TEXT = {"Text", "List-item"}
TEST_SHARE = 0.3


def is_two_columns(boxes) -> bool:
    text = [b for b in boxes if b["category"] in TEXT]
    if len(text) < 4:
        return False
    left = min(b["box"][0] for b in boxes)
    right = max(b["box"][0] + b["box"][2] for b in boxes)
    width = right - left
    mid = left + width / 2
    narrow = [b for b in text if b["box"][2] < width * 0.55]
    in_left = [b for b in narrow if b["box"][0] + b["box"][2] <= mid + width * 0.05]
    in_right = [b for b in narrow if b["box"][0] >= mid - width * 0.05]
    # Most of the text sits in narrow boxes, with real content on both sides.
    return len(in_left) >= 2 and len(in_right) >= 2 and len(narrow) >= 0.6 * len(text)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for split in ("train", "test"):
        for ann_path in sorted((SOURCE / split / "annotations").glob("*.json")):
            ann = json.loads(ann_path.read_text())
            pdf_path = SOURCE / split / "pdfs" / f"{ann_path.stem}.pdf"
            if not pdf_path.exists():
                continue
            # Each annotation repeats its box once per text line: keep one entry per box.
            boxes = list({b["id_box"]: b for b in ann["form"]}.values())
            categories = {b["category"] for b in boxes}
            with pymupdf.open(pdf_path) as doc:
                page = doc[0]
                matrix = pymupdf.Matrix(IMG_W / page.rect.width, IMG_H / page.rect.height)
                page.get_pixmap(matrix=matrix, colorspace=pymupdf.csGRAY).save(OUT / f"{ann_path.stem}.png")
            rows.append([f"{ann_path.stem}.png", int("Table" in categories), int("Picture" in categories),
                         int(is_two_columns(boxes)), ann["metadata"]["doc_category"],
                         ann["metadata"]["original_filename"]])

    # Split by source document, not by page: pages of one report look alike, and seeing
    # some of them in training would make the test look better than it is.
    docs = sorted({r[5] for r in rows})
    random.Random(0).shuffle(docs)
    test_docs = set(docs[: int(len(docs) * TEST_SHARE)])
    header = ["file", "table", "figure", "two_columns", "doc_category", "document"]
    for name, subset in (("labels.csv", rows), ("train.csv", [r for r in rows if r[5] not in test_docs]),
                         ("test.csv", [r for r in rows if r[5] in test_docs])):
        with open(OUT / name, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(header)
            writer.writerows(subset)
        print(f"{name}: {len(subset)} pages  " + "  ".join(
            f"{label} {sum(r[i] for r in subset)}" for i, label in enumerate(["table", "figure", "two_columns"], start=1)))


if __name__ == "__main__":
    main()
