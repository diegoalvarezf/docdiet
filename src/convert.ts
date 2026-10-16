import { readFile } from 'node:fs/promises';
import { extractTextItems, getDocumentProxy } from 'unpdf';
import { labelsOf, pageProbabilities, type PageLabel } from './classify.js';
import { pagesToMarkdown, type PageInput } from './markdown.js';

export interface Conversion {
  markdown: string;
  totalPages: number;
  convertedPages: number[];
  textlessPages: number[];
  rawTextChars: number;
  pageSizes: PageSize[];
  // Classifier labels for pages that have any; empty when classification is off or failed.
  pageLabels: Record<number, PageLabel[]>;
}

// In PDF points (1/72 inch), rotation applied: the size pdftoppm renders.
export interface PageSize {
  width: number;
  height: number;
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
    const pageLabels = await classify(pdf, convertedPages.filter((n) => (items[n - 1] ?? []).length > 0));
    const pages: PageInput[] = convertedPages.map((number) => ({
      number,
      items: items[number - 1] ?? [],
      labels: pageLabels[number],
    }));
    const rawTextChars = pages.reduce((sum, p) => sum + p.items.reduce((s, i) => s + i.str.length, 0), 0);
    const pageSizes = await Promise.all(
      convertedPages.map(async (number) => {
        const { width, height } = (await pdf.getPage(number)).getViewport({ scale: 1 });
        return { width, height };
      }),
    );
    const { markdown, textlessPages } = pagesToMarkdown(pages);
    return { markdown, totalPages, convertedPages, textlessPages, rawTextChars, pageSizes, pageLabels };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// The classifier only adds notes: if it is disabled (DOCDIET_CLASSIFY=0) or fails, convert without them.
async function classify(pdf: Parameters<typeof pageProbabilities>[0], pages: number[]): Promise<Record<number, PageLabel[]>> {
  if (process.env.DOCDIET_CLASSIFY === '0' || pages.length === 0) return {};
  try {
    const labels: Record<number, PageLabel[]> = {};
    for (const [page, probabilities] of await pageProbabilities(pdf, pages)) {
      const found = labelsOf(probabilities);
      if (found.length) labels[page] = found;
    }
    return labels;
  } catch {
    return {};
  }
}
