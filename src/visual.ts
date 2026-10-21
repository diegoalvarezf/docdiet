import { getResolvedPDFJS, renderPageAsImage, type getDocumentProxy } from 'unpdf';
import type { TextItem } from './markdown.js';

type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

// What the text layer misses, found by ink outside the text boxes on a small render: embedded
// images and vector drawings alike. Ink that sits on most pages of the same size (logos, frames,
// running decorations) is the page template and does not count.
//
// - Visual page: mostly an image with a few words (handwriting, slide diagrams, screenshots).
//   Measured on real course PDFs: text pages 0-8% ink outside text with 100+ words; handwritten
//   pages 2-5% with 1-4 words; slides with diagrams or screenshots 13-97% with under 25 words.
// - Figure: a text page that also carries a picture (a circuit, a chart) the Markdown drops. Thin
//   line art barely inks a small render, so embedded images are also read from the PDF itself.
const RENDER_WIDTH = 200;
const INK_GRAY = 230;
const VISUAL_MIN_INK = 0.02;
const VISUAL_MAX_WORDS = 40;
const FIGURE_MIN_INK = 0.03;
const TEMPLATE_SHARE = 0.5;
const TEMPLATE_MIN_PAGES = 4;
const FIGURE_MIN_IMAGE_AREA = 0.02;
// A picture has some body; thin strips (images under each text line, rules) are not figures.
const FIGURE_MIN_IMAGE_SIDE = 30;
const FIGURE_MIN_SINGLE_IMAGE_AREA = 0.01;

export interface PageInk {
  visual: Set<number>;
  figures: Set<number>;
}

interface Render {
  page: number;
  key: string;
  // 1 where there is ink outside the text boxes.
  ink: Uint8Array;
}

async function renderInk(pdf: PDFDocumentProxy, pageNumber: number, items: TextItem[]): Promise<Render> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const viewport = (await pdf.getPage(pageNumber)).getViewport({ scale: 1 });
  const scale = RENDER_WIDTH / viewport.width;
  const w = RENDER_WIDTH;
  const h = Math.max(1, Math.round(viewport.height * scale));
  const png = await renderPageAsImage(pdf, pageNumber, { canvasImport: () => import('@napi-rs/canvas'), width: w });
  const context = createCanvas(w, h).getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, w, h);
  context.drawImage(await loadImage(Buffer.from(png)), 0, 0, w, h);
  const rgba = context.getImageData(0, 0, w, h).data;

  // Text boxes: item y is the baseline, so the glyphs sit from ~0.3 em below to 1 em above it.
  const text = new Uint8Array(w * h);
  for (const item of items) {
    if (!item.str.trim()) continue;
    const x0 = Math.max(0, Math.floor(item.x * scale) - 1);
    const x1 = Math.min(w, Math.ceil((item.x + item.width) * scale) + 1);
    const y0 = Math.max(0, Math.floor((viewport.height - item.y - item.fontSize) * scale) - 1);
    const y1 = Math.min(h, Math.ceil((viewport.height - item.y + item.fontSize * 0.3) * scale) + 1);
    for (let y = y0; y < y1; y++) text.fill(1, y * w + x0, y * w + x1);
  }
  const ink = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const gray = 0.299 * rgba[p * 4] + 0.587 * rgba[p * 4 + 1] + 0.114 * rgba[p * 4 + 2];
    if (gray < INK_GRAY && !text[p]) ink[p] = 1;
  }
  return { page: pageNumber, key: `${w}x${h}`, ink };
}

type Matrix = [number, number, number, number, number, number];
type Box = { x0: number; y0: number; x1: number; y1: number };

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

// Boxes, in PDF points, of the images a page paints: each image fills the unit square of the
// transform current when it is drawn, so the operator list is replayed keeping track of it.
async function imageBoxes(pdf: PDFDocumentProxy, pageNumber: number): Promise<Box[]> {
  const { OPS } = await getResolvedPDFJS();
  const { fnArray, argsArray } = await (await pdf.getPage(pageNumber)).getOperatorList();
  const images = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat]);
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const boxes: Box[] = [];
  fnArray.forEach((fn, i) => {
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = multiply(ctm, args[0] as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (images.has(fn)) {
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      boxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    }
  });
  return boxes;
}

const boxKey = (b: Box) => [b.x0, b.y0, b.x1, b.y1].map((v) => Math.round(v / 5)).join(',');

export function wordCount(items: TextItem[]): number {
  return items.reduce((sum, i) => sum + (i.str.match(/\S+/g)?.length ?? 0), 0);
}

// Pages (from the given ones, which have text) that are mostly an image, and text pages with a
// figure. A page that fails to render counts as plain text, which is how docdiet behaved before.
export async function pageInk(pdf: PDFDocumentProxy, pages: number[], items: TextItem[][]): Promise<PageInk> {
  const renders: Render[] = [];
  const images = new Map<number, Box[]>();
  for (const page of pages) {
    try {
      renders.push(await renderInk(pdf, page, items[page - 1] ?? []));
      images.set(page, await imageBoxes(pdf, page));
    } catch {
      // keep it as a text page
    }
  }
  // Images in the same place on half the pages or more are logos and decorations.
  const placed = new Map<string, number>();
  for (const boxes of images.values()) for (const key of new Set(boxes.map(boxKey))) placed.set(key, (placed.get(key) ?? 0) + 1);
  const repeated = (b: Box) => images.size >= 2 && (placed.get(boxKey(b)) ?? 0) >= images.size * TEMPLATE_SHARE;

  const templates = new Map<string, Uint8Array>();
  for (const key of new Set(renders.map((r) => r.key))) {
    const group = renders.filter((r) => r.key === key);
    if (group.length < TEMPLATE_MIN_PAGES) continue;
    const counts = new Uint16Array(group[0].ink.length);
    for (const r of group) r.ink.forEach((v, p) => (counts[p] += v));
    templates.set(key, Uint8Array.from(counts, (n) => (n >= group.length * TEMPLATE_SHARE ? 1 : 0)));
  }

  const result: PageInk = { visual: new Set(), figures: new Set() };
  for (const r of renders) {
    const template = templates.get(r.key);
    let ink = 0;
    let own = 0;
    r.ink.forEach((v, p) => {
      ink += v;
      own += v && !template?.[p] ? 1 : 0;
    });
    // A slide's own background is part of what makes it visual; only figures discount the template.
    const share = ink / r.ink.length;
    const ownShare = own / r.ink.length;
    const viewport = (await pdf.getPage(r.page)).getViewport({ scale: 1 });
    const pageArea = viewport.width * viewport.height;
    const imageArea = (images.get(r.page) ?? [])
      .filter((b) => !repeated(b))
      .filter((b) => Math.min(b.x1 - b.x0, b.y1 - b.y0) >= FIGURE_MIN_IMAGE_SIDE)
      .filter((b) => ((b.x1 - b.x0) * (b.y1 - b.y0)) / pageArea >= FIGURE_MIN_SINGLE_IMAGE_AREA)
      .reduce((sum, b) => sum + (b.x1 - b.x0) * (b.y1 - b.y0), 0) / pageArea;
    if (wordCount(items[r.page - 1] ?? []) < VISUAL_MAX_WORDS && share >= VISUAL_MIN_INK) result.visual.add(r.page);
    // Without enough pages to learn the template, ink alone would flag every logo and frame.
    else if (imageArea >= FIGURE_MIN_IMAGE_AREA || (template && ownShare >= FIGURE_MIN_INK)) result.figures.add(r.page);
  }
  return result;
}
