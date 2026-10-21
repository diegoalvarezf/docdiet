import { renderPageAsImage, type getDocumentProxy } from 'unpdf';
import type { TextItem } from './markdown.js';

type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

// Pages whose content is mostly an image (handwriting, diagrams, screenshots) still carry a few
// words (a title, a page number), so they are not "textless", but their Markdown would be nearly
// empty. They are found by ink outside the text boxes on a small render, together with little text.
// Measured on real course PDFs: text pages 0-8% ink outside text with 100+ words; handwritten pages
// 2-5% with 1-4 words; slides with diagrams or screenshots 13-97% with under 25 words.
const RENDER_WIDTH = 200;
const INK_GRAY = 230;
const MIN_INK = 0.02;
const MAX_WORDS = 40;

async function inkOutsideText(pdf: PDFDocumentProxy, pageNumber: number, items: TextItem[]): Promise<number> {
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
  let ink = 0;
  for (let p = 0; p < w * h; p++) {
    const gray = 0.299 * rgba[p * 4] + 0.587 * rgba[p * 4 + 1] + 0.114 * rgba[p * 4 + 2];
    if (gray < INK_GRAY && !text[p]) ink++;
  }
  return ink / (w * h);
}

export function wordCount(items: TextItem[]): number {
  return items.reduce((sum, i) => sum + (i.str.match(/\S+/g)?.length ?? 0), 0);
}

// Pages (from the given ones, which have text) that are mostly an image. On any rendering failure
// the page counts as text, which is how docdiet behaved before.
export async function visualPages(pdf: PDFDocumentProxy, pages: number[], items: TextItem[][]): Promise<Set<number>> {
  const visual = new Set<number>();
  for (const page of pages) {
    const pageItems = items[page - 1] ?? [];
    if (wordCount(pageItems) >= MAX_WORDS) continue;
    try {
      if ((await inkOutsideText(pdf, page, pageItems)) >= MIN_INK) visual.add(page);
    } catch {
      // keep it as a text page
    }
  }
  return visual;
}
