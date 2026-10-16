"""DocLayNet v1.2 shards (full human annotations, one PDF page per row) -> our format.

Unlike DocLayNet-small, every region is annotated, including pictures with no text in them.
The test shard becomes test.csv; the train shard is split by source document into train.csv
and val.csv (val picks the best epoch, so the test stays untouched).

    ml/.venv/bin/python ml/prepare_doclaynet12.py
"""

import csv
import random
from pathlib import Path

import pyarrow.parquet as pq
import pymupdf

from generate import IMG_H, IMG_W
from prepare_doclaynet import is_two_columns

ML_DIR = Path(__file__).parent
SOURCE = ML_DIR / "data" / "doclaynet12"
OUT = ML_DIR / "data" / "real12"
VAL_SHARE = 0.15
# Logos and icons are annotated as pictures too; they don't matter for reading a document.
MIN_FIGURE_AREA = 0.02

# DocLayNet COCO category ids
CATEGORIES = {1: "Caption", 2: "Footnote", 3: "Formula", 4: "List-item", 5: "Page-footer", 6: "Page-header",
              7: "Picture", 8: "Section-header", 9: "Table", 10: "Text", 11: "Title"}


def convert(shard: Path):
    rows = []
    parquet = pq.ParquetFile(shard)
    for group in range(parquet.num_row_groups):
        table = parquet.read_row_group(group, columns=["pdf", "bboxes", "category_id", "metadata"])
        for record in table.to_pylist():
            meta = record["metadata"]
            page_area = meta["coco_width"] * meta["coco_height"]
            boxes = [{"box": b, "category": CATEGORIES.get(c, "?")} for b, c in zip(record["bboxes"], record["category_id"])]
            has_table = any(b["category"] == "Table" for b in boxes)
            has_figure = any(b["category"] == "Picture" and b["box"][2] * b["box"][3] >= MIN_FIGURE_AREA * page_area for b in boxes)
            name = f"{meta['page_hash']}.png"
            with pymupdf.open(stream=record["pdf"], filetype="pdf") as doc:
                page = doc[0]
                matrix = pymupdf.Matrix(IMG_W / page.rect.width, IMG_H / page.rect.height)
                page.get_pixmap(matrix=matrix, colorspace=pymupdf.csGRAY).save(OUT / name)
            rows.append([name, int(has_table), int(has_figure), int(is_two_columns(boxes)),
                         meta["doc_category"], meta["original_filename"]])
    return rows


def write(name, rows):
    with open(OUT / name, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["file", "table", "figure", "two_columns", "doc_category", "document"])
        writer.writerows(rows)
    print(f"{name}: {len(rows)} pages  " + "  ".join(
        f"{label} {sum(r[i] for r in rows)}" for i, label in enumerate(["table", "figure", "two_columns"], start=1)))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    pymupdf.TOOLS.mupdf_display_errors(False)
    test = [r for shard in sorted(SOURCE.glob("test-*.parquet")) for r in convert(shard)]
    train = [r for shard in sorted(SOURCE.glob("train-*.parquet")) for r in convert(shard)]

    docs = sorted({r[5] for r in train})
    random.Random(0).shuffle(docs)
    val_docs = set(docs[: int(len(docs) * VAL_SHARE)])
    test_docs = {r[5] for r in test}
    # A document present in the test shard must not leak into training.
    train = [r for r in train if r[5] not in test_docs]
    write("test.csv", test)
    write("train.csv", [r for r in train if r[5] not in val_docs])
    write("val.csv", [r for r in train if r[5] in val_docs])


if __name__ == "__main__":
    main()
