"""Synthetic training pages: random documents with known labels.

Each page randomly gets a table, a figure and one or two text columns. Because we draw
the page ourselves, the labels are free and always right.

    ml/.venv/bin/python ml/generate.py --count 6000
"""

import argparse
import csv
import io
import random
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image

PAGE_W, PAGE_H = 595, 842  # A4 in points
IMG_W, IMG_H = 224, 320  # model input, keeps the A4 aspect ratio
FONTS = ["helv", "tiro", "cour"]

WORDS = (
    "the of and to in is for that with as on by this are be from at an which data system results "
    "model analysis report we table value study method process group time year total number based "
    "el de la que en los se del las un por con para una es su al lo como más pero sus le ya o "
    "informe resultados análisis datos sistema proceso año total valor estudio método grupo tiempo"
).split()


def words(rng, n):
    return " ".join(rng.choice(WORDS) for _ in range(n))


def paragraph(rng, n_words):
    sentences, left = [], n_words
    while left > 0:
        n = min(left, rng.randint(6, 18))
        s = words(rng, n)
        sentences.append(s[0].upper() + s[1:] + ".")
        left -= n
    return " ".join(sentences)


def fill_box(page, box, rng, font, size, align):
    """insert_textbox draws nothing when the text overflows, so shrink until it fits."""
    lines = box.height / (size * 1.2)
    n = max(3, int(lines * box.width / (size * 0.5) / 6))
    while n >= 3:
        if page.insert_textbox(box, paragraph(rng, n), fontsize=size, fontname=font, align=align) >= 0:
            return
        n = int(n * 0.8)


def draw_text_block(page, rect, rng, font, size):
    """Fills rect with paragraphs and the odd heading; returns the y where text ended."""
    y = rect.y0
    while y < rect.y1 - size * 2:
        if rng.random() < 0.15:
            hsize = size * rng.uniform(1.3, 1.8)
            box = pymupdf.Rect(rect.x0, y, rect.x1, y + hsize * 1.6)
            page.insert_textbox(box, words(rng, rng.randint(2, 6)).title(), fontsize=hsize, fontname=font)
            y = box.y1 + size * 0.5
            continue
        lines = rng.randint(2, 9)
        box = pymupdf.Rect(rect.x0, y, rect.x1, min(rect.y1, y + lines * size * 1.25))
        fill_box(page, box, rng, font, size, rng.choice([0, 3]))
        y = box.y1 + size * rng.uniform(0.6, 1.5)
    return y


def cell_text(rng):
    r = rng.random()
    if r < 0.4:
        return f"{rng.uniform(0, 10000):,.{rng.choice([0, 1, 2])}f}"
    if r < 0.5:
        return f"{rng.uniform(0, 100):.1f}%"
    return words(rng, rng.randint(1, 2))


def draw_table(page, rect, rng, font, size):
    rows, cols = rng.randint(3, 14), rng.randint(2, 7)
    style = rng.choice(["grid", "rules", "none", "zebra"])
    row_h = min((rect.height) / rows, size * 2.2)
    col_w = rect.width / cols
    height = row_h * rows
    for r in range(rows):
        y = rect.y0 + r * row_h
        if style == "zebra" and r % 2 == 1:
            page.draw_rect(pymupdf.Rect(rect.x0, y, rect.x1, y + row_h), color=None, fill=(0.9, 0.9, 0.9))
        for c in range(cols):
            text = words(rng, rng.randint(1, 2)).title() if r == 0 else cell_text(rng)
            box = pymupdf.Rect(rect.x0 + c * col_w + 2, y + 2, rect.x0 + (c + 1) * col_w - 2, y + row_h)
            page.insert_textbox(box, text, fontsize=size * 0.9, fontname=font, align=2 if c and r else 0)
    line = dict(color=(0, 0, 0), width=rng.uniform(0.4, 1.2))
    bottom = rect.y0 + height
    if style == "grid":
        for r in range(rows + 1):
            page.draw_line((rect.x0, rect.y0 + r * row_h), (rect.x1, rect.y0 + r * row_h), **line)
        for c in range(cols + 1):
            page.draw_line((rect.x0 + c * col_w, rect.y0), (rect.x0 + c * col_w, bottom), **line)
    elif style in ("rules", "zebra"):
        for y in (rect.y0, rect.y0 + row_h, bottom):
            page.draw_line((rect.x0, y), (rect.x1, y), **line)
    return bottom


def draw_figure(page, rect, rng):
    kind = rng.choice(["bars", "lines", "pie", "photo", "diagram"])
    color = lambda: (rng.random(), rng.random(), rng.random())
    if kind in ("bars", "lines"):
        x0, y1 = rect.x0 + 20, rect.y1 - 15
        page.draw_line((x0, rect.y0), (x0, y1), color=(0, 0, 0))
        page.draw_line((x0, y1), (rect.x1, y1), color=(0, 0, 0))
        n = rng.randint(4, 14)
        step = (rect.x1 - x0) / n
        if kind == "bars":
            for i in range(n):
                h = rng.uniform(0.1, 0.95) * (y1 - rect.y0)
                page.draw_rect(pymupdf.Rect(x0 + i * step + 3, y1 - h, x0 + (i + 1) * step - 3, y1), color=None, fill=color())
        else:
            for _ in range(rng.randint(1, 3)):
                pts = [(x0 + i * step, y1 - rng.uniform(0.1, 0.95) * (y1 - rect.y0)) for i in range(n + 1)]
                page.draw_polyline(pts, color=color(), width=rng.uniform(1, 2.5))
    elif kind == "pie":
        center = rect.tl + (rect.width / 2, rect.height / 2)
        radius = min(rect.width, rect.height) / 2 - 5
        start, angles = 0, rng.sample(range(20, 340), rng.randint(2, 5))
        for end in sorted(angles) + [360]:
            point = center + pymupdf.Point(radius, 0) * pymupdf.Matrix(start)
            page.draw_sector(center, point, end - start, color=(1, 1, 1), fill=color())
            start = end
    elif kind == "photo":
        h, w = rng.randint(30, 120), rng.randint(30, 120)
        noise = np.random.default_rng(rng.randint(0, 2**31)).integers(0, 255, (h, w, 3), dtype=np.uint8)
        smooth = Image.fromarray(noise).resize((w * 4, h * 4), Image.BICUBIC)
        buf = io.BytesIO()
        smooth.save(buf, format="PNG")
        page.insert_image(rect, stream=buf.getvalue(), keep_proportion=False)
    else:
        for _ in range(rng.randint(3, 7)):
            bw, bh = rect.width * rng.uniform(0.15, 0.3), rect.height * rng.uniform(0.12, 0.25)
            bx, by = rng.uniform(rect.x0, rect.x1 - bw), rng.uniform(rect.y0, rect.y1 - bh)
            page.draw_rect(pymupdf.Rect(bx, by, bx + bw, by + bh), color=(0, 0, 0), fill=color(), width=1)
    return rect.y1


def make_page(seed):
    rng = random.Random(seed)
    two_col = rng.random() < 0.5
    has_table = rng.random() < 0.5
    has_figure = rng.random() < 0.5

    doc = pymupdf.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    font = rng.choice(FONTS)
    size = rng.uniform(8, 12)
    margin = rng.uniform(40, 80)
    gutter = rng.uniform(15, 30)
    top, bottom = margin, PAGE_H - margin
    left, right = margin, PAGE_W - margin

    if two_col:
        mid = (left + right) / 2
        columns = [pymupdf.Rect(left, top, mid - gutter / 2, bottom), pymupdf.Rect(mid + gutter / 2, top, right, bottom)]
    else:
        columns = [pymupdf.Rect(left, top, right, bottom)]

    # Place the table / figure in a random column (or spanning both), at a random height.
    inserts = [k for k, on in (("table", has_table), ("figure", has_figure)) if on]
    rng.shuffle(inserts)
    for kind in inserts:
        col = rng.choice(columns)
        span = two_col and rng.random() < 0.3
        x0, x1 = (left, right) if span else (col.x0, col.x1)
        h = rng.uniform(0.18, 0.35) * (bottom - top)
        lo, hi = (top, bottom) if span or col.height < h else (col.y0, col.y1)
        y0 = rng.uniform(lo, hi - h)
        rect = pymupdf.Rect(x0, y0, x1, y0 + h)
        targets = columns if span else [col]
        if kind == "table":
            draw_table(page, rect, rng, font, size)
        else:
            draw_figure(page, rect, rng)
            page.insert_textbox(pymupdf.Rect(x0, rect.y1 + 2, x1, rect.y1 + size * 2.5),
                                f"Figure {rng.randint(1, 20)}. {words(rng, rng.randint(3, 10))}",
                                fontsize=size * 0.9, fontname=font)
        # Text flows above and below the insert, never on top of it.
        split = []
        for c in columns:
            if any(c.x0 >= t.x0 - 1 and c.x1 <= t.x1 + 1 for t in targets) and c.y0 < rect.y1 and c.y1 > y0:
                split += [pymupdf.Rect(c.x0, c.y0, c.x1, min(c.y1, y0 - size)),
                          pymupdf.Rect(c.x0, max(c.y0, rect.y1 + size * 3), c.x1, c.y1)]
            else:
                split.append(c)
        columns = [c for c in split if c.height > size * 3]

    for col in columns:
        draw_text_block(page, col, rng, font, size)

    pix = page.get_pixmap(matrix=pymupdf.Matrix(IMG_W / PAGE_W, IMG_H / PAGE_H), colorspace=pymupdf.csGRAY)
    doc.close()
    return pix.tobytes("png"), int(has_table), int(has_figure), int(two_col)


def render(job):
    out_dir, seed = job
    png, table, figure, two_col = make_page(seed)
    name = f"{seed:07d}.png"
    (out_dir / name).write_bytes(png)
    return name, table, figure, two_col


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=6000)
    parser.add_argument("--val", type=float, default=0.15, help="share kept apart to check the model")
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "data" / "synth")
    args = parser.parse_args()

    n_val = int(args.count * args.val)
    splits = {"val": range(0, n_val), "train": range(n_val, args.count)}
    with Pool() as pool:
        for split, seeds in splits.items():
            out_dir = args.out / split
            out_dir.mkdir(parents=True, exist_ok=True)
            rows = pool.map(render, [(out_dir, s) for s in seeds], chunksize=64)
            with open(out_dir / "labels.csv", "w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(["file", "table", "figure", "two_columns"])
                writer.writerows(rows)
            print(f"{split}: {len(rows)} pages -> {out_dir}")


if __name__ == "__main__":
    main()
