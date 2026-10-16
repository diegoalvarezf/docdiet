import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderPageAsImage, type getDocumentProxy } from 'unpdf';
import type { TextItem } from './markdown.js';

type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

// OCR for pages without a text layer, with the system's Tesseract (optional: without it, scans
// pass through to Claude as before). Words come back with their boxes, so they become the same
// positioned items pdf.js gives and the rest of the pipeline (headings, columns, tables) applies.

const run = promisify(execFile);
const DPI = 300;
// Below this mean word confidence the page image is better left to Claude.
const MIN_CONFIDENCE = 70;
const DEFAULT_LANGS = 'eng+spa';
// Hooks run under Claude Code's 120 s hook timeout; leave room for rendering and classification.
export const HOOK_OCR_BUDGET_MS = 60_000;

export interface OcrPage {
  items: TextItem[];
  confidence: number;
}

let available: Promise<boolean> | undefined;

export function tesseractAvailable(): Promise<boolean> {
  available ??= run('tesseract', ['--version'], { timeout: 5000 }).then(
    () => true,
    () => false,
  );
  return available;
}

function languages(): string {
  return process.env.DOCDIET_OCR_LANGS || DEFAULT_LANGS;
}

// Tesseract TSV: level 4 rows are lines, level 5 rows are words; boxes in pixels from the top left.
export function tsvToItems(tsv: string, pageHeight: number, scale: number): OcrPage {
  const lines = new Map<string, { top: number; height: number }>();
  const words: { key: string; left: number; top: number; width: number; height: number; conf: number; text: string }[] = [];
  for (const row of tsv.split('\n').slice(1)) {
    const f = row.split('\t');
    if (f.length < 12) continue;
    const [level, , block, par, line, , left, top, width, height, conf] = f.slice(0, 11).map(Number);
    const key = `${block}.${par}.${line}`;
    if (level === 4) lines.set(key, { top, height });
    const text = f.slice(11).join('\t').trim();
    if (level === 5 && text && conf >= 0) words.push({ key, left, top, width, height, conf, text });
  }

  let weighted = 0;
  let chars = 0;
  const items = words.map((w) => {
    weighted += w.conf * w.text.length;
    chars += w.text.length;
    // Words of a line share its box: their own boxes move with descenders and would split the line.
    // A line box spans ascenders to descenders, about 1.2 font sizes.
    const line = lines.get(w.key) ?? { top: w.top, height: w.height };
    const fontSize = line.height / scale / 1.2;
    return {
      str: w.text,
      x: w.left / scale,
      y: pageHeight - (line.top + line.height) / scale,
      width: w.width / scale,
      fontSize,
    };
  });
  return { items, confidence: chars ? weighted / chars : 0 };
}

async function ocrPage(pdf: PDFDocumentProxy, pageNumber: number, dir: string): Promise<OcrPage> {
  const page = await pdf.getPage(pageNumber);
  const { height } = page.getViewport({ scale: 1 });
  const scale = DPI / 72;
  const png = await renderPageAsImage(pdf, pageNumber, { canvasImport: () => import('@napi-rs/canvas'), scale });
  const file = join(dir, `page-${pageNumber}.png`);
  await writeFile(file, Buffer.from(png));
  const { stdout } = await run('tesseract', [file, 'stdout', '-l', languages(), '--psm', '3', 'tsv'], {
    // One thread per process; pages run in parallel instead.
    env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return tsvToItems(stdout, height, scale);
}

// OCRs the given pages in parallel until the time budget runs out; pages not reached, failed or
// below the confidence bar are left out of the result.
export async function ocrPages(pdf: PDFDocumentProxy, pages: number[], budgetMs = Infinity): Promise<Map<number, OcrPage>> {
  const result = new Map<number, OcrPage>();
  if (pages.length === 0 || process.env.DOCDIET_OCR === '0' || !(await tesseractAvailable())) return result;
  const deadline = Date.now() + budgetMs;
  const dir = await mkdtemp(join(tmpdir(), 'docdiet-ocr-'));
  try {
    const queue = [...pages];
    const worker = async () => {
      for (let page = queue.shift(); page !== undefined && Date.now() < deadline; page = queue.shift()) {
        try {
          const ocr = await ocrPage(pdf, page, dir);
          if (ocr.confidence >= MIN_CONFIDENCE && ocr.items.length > 0) result.set(page, ocr);
        } catch {
          // this page stays without text
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(availableParallelism(), pages.length) }, worker));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return result;
}
