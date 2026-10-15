import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { docdietHome } from './cache.js';
import type { Conversion } from './convert.js';

// Rough figures: ~4 characters per token. Claude reads each PDF page as extracted text
// plus a page image, and a page image costs roughly 1,600 tokens.
const CHARS_PER_TOKEN = 4;
const PAGE_IMAGE_TOKENS = 1600;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimatePdfTokens(conversion: Pick<Conversion, 'rawTextChars' | 'convertedPages'>): number {
  return Math.ceil(conversion.rawTextChars / CHARS_PER_TOKEN) + conversion.convertedPages.length * PAGE_IMAGE_TOKENS;
}

export interface StatEntry {
  ts: string;
  file: string;
  pages: number;
  pdfTokens: number;
  markdownTokens: number;
  cached: boolean;
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
