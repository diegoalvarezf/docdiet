import { readFile } from 'node:fs/promises';
import { extractTextItems, getDocumentProxy } from 'unpdf';
import { pagesToMarkdown, type PageInput } from './markdown.js';

export interface Conversion {
  markdown: string;
  totalPages: number;
  convertedPages: number[];
  textlessPages: number[];
  rawTextChars: number;
}

export function parsePageRange(spec: string | undefined, totalPages: number): number[] {
  const all = Array.from({ length: totalPages }, (_, i) => i + 1);
  if (!spec?.trim()) return all;
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/.exec(part);
    if (!match) throw new Error(`invalid page range: ${spec}`);
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : match[2] === '' ? totalPages : Number(match[2]);
    for (let p = start; p <= Math.min(end, totalPages); p++) if (p >= 1) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

export async function convertPdf(path: string, pageSpec?: string): Promise<Conversion> {
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
  try {
    const { totalPages, items } = await extractTextItems(pdf);
    const convertedPages = parsePageRange(pageSpec, totalPages);
    const pages: PageInput[] = convertedPages.map((number) => ({ number, items: items[number - 1] ?? [] }));
    const rawTextChars = pages.reduce((sum, p) => sum + p.items.reduce((s, i) => s + i.str.length, 0), 0);
    const { markdown, textlessPages } = pagesToMarkdown(pages);
    return { markdown, totalPages, convertedPages, textlessPages, rawTextChars };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
