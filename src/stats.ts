import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { docdietHome } from './cache.js';
import type { Conversion, PageSize } from './convert.js';

// Same rough rule Claude Code uses for text: ~4 characters per token.
const CHARS_PER_TOKEN = 4;

// How Claude Code 2.1.201 sends a PDF read without docdiet (docs/claude-code-internals.md):
// - 'document': the whole file as one document block (no `pages`, at most 10 pages);
//   the API turns every page into extracted text plus a page image.
// - 'images': with `pages`, or past 10 pages (Read refuses the whole file, so Claude pages
//   through it), pdftoppm renders JPEGs at 100 DPI and only the images are sent, no text.
export type PdfReadMode = 'document' | 'images';
const MAX_WHOLE_PDF_PAGES = 10;
const RENDER_DPI = 100;
const MAX_IMAGE_SIDE = 2000;
const IMAGE_PATCH_PX = 28;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function pdfReadMode(pageSpec: string | undefined, totalPages: number): PdfReadMode {
  return pageSpec?.trim() || totalPages > MAX_WHOLE_PDF_PAGES ? 'images' : 'document';
}

// Claude Code's own image estimate: one token per 28×28 px patch, after shrinking to fit 2000×2000.
// The API's resolution for document pages is not public; we assume the same 100 DPI rendering.
export function pageImageTokens({ width, height }: PageSize): number {
  const px = (points: number) => (points / 72) * RENDER_DPI;
  const scale = Math.min(1, MAX_IMAGE_SIDE / px(width), MAX_IMAGE_SIDE / px(height));
  const patches = (points: number) => Math.ceil((px(points) * scale) / IMAGE_PATCH_PX);
  return patches(width) * patches(height);
}

export function estimatePdfTokens(
  conversion: Pick<Conversion, 'rawTextChars' | 'pageSizes'>,
  mode: PdfReadMode,
): number {
  const images = conversion.pageSizes.reduce((sum, size) => sum + pageImageTokens(size), 0);
  return mode === 'images' ? images : images + Math.ceil(conversion.rawTextChars / CHARS_PER_TOKEN);
}

export interface StatEntry {
  ts: string;
  file: string;
  pages: number;
  pdfTokens: number;
  markdownTokens: number;
  cached: boolean;
  readMode?: PdfReadMode;
}

function statsPath(): string {
  return join(docdietHome(), 'stats.jsonl');
}

export async function recordStat(entry: StatEntry): Promise<void> {
  await mkdir(docdietHome(), { recursive: true });
  await appendFile(statsPath(), JSON.stringify(entry) + '\n');
}

export async function readStats(): Promise<StatEntry[]> {
  if (!existsSync(statsPath())) return [];
  const lines = (await readFile(statsPath(), 'utf8')).split('\n').filter(Boolean);
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as StatEntry];
    } catch {
      return [];
    }
  });
}
