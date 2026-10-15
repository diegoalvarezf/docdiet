export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

export interface PageInput {
  number: number;
  items: TextItem[];
}

export interface MarkdownResult {
  markdown: string;
  textlessPages: number[];
}

interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
}

const BULLET = /^([•◦▪‣∙·●○■□–-]|\*|\d{1,3}[.)]|[a-z][.)])\s+/;
const PAGE_NUMBER = /^(page\s*)?\d{1,4}(\s*(of|\/|de)\s*\d{1,4})?$/i;

function buildLines(items: TextItem[]): Line[] {
  const sorted = items
    .filter((i) => i.str.length > 0)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const rows: TextItem[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    const tolerance = Math.max(item.fontSize, 1) * 0.5;
    if (row && Math.abs(row[0].y - item.y) <= tolerance) row.push(item);
    else rows.push([item]);
  }

  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let text = '';
    let end = -Infinity;
    let sizeWeight = 0;
    let sizeSum = 0;
    for (const item of row) {
      // pdf.js splits words into separate items; a visible gap means a space
      const gap = item.x - end;
      if (text && gap > item.fontSize * 0.15 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += ' ';
      text += item.str;
      end = item.x + item.width;
      const chars = item.str.trim().length;
      sizeSum += item.fontSize * chars;
      sizeWeight += chars;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push({ text, x: row[0].x, y: row[0].y, size: sizeWeight ? sizeSum / sizeWeight : row[0].fontSize });
  }
  return lines;
}

function bodySize(pages: Line[][]): number {
  const weights = new Map<number, number>();
  for (const line of pages.flat()) {
    const size = Math.round(line.size * 2) / 2;
    weights.set(size, (weights.get(size) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best || 10;
}

// Points from the highest / lowest text in the document that still count as header / footer.
const EDGE_BAND = 40;

type EdgeTest = (line: Line, index: number, pageLines: Line[]) => boolean;

function edgeTest(pages: Line[][]): EdgeTest {
  const ys = pages.flat().map((l) => l.y);
  const top = Math.max(...ys);
  const bottom = Math.min(...ys);
  return (line, index, pageLines) =>
    (index < 2 || index >= pageLines.length - 2) && (line.y >= top - EDGE_BAND || line.y <= bottom + EDGE_BAND);
}

// Running headers/footers and page numbers repeat on most pages and only waste tokens.
function repeatedEdgeLines(pages: Line[][], isEdge: EdgeTest): Set<string> {
  const counts = new Map<string, number>();
  const withText = pages.filter((p) => p.length > 0);
  for (const lines of withText) {
    const edges = new Set(lines.filter(isEdge).map((l) => normalizeEdge(l.text)));
    for (const key of edges) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const minPages = Math.max(2, Math.ceil(withText.length * 0.5));
  return new Set([...counts].filter(([, n]) => n >= minPages).map(([key]) => key));
}

function normalizeEdge(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#');
}

function headingLevels(pages: Line[][], body: number): Map<number, number> {
  const sizes = new Set<number>();
  for (const line of pages.flat()) {
    if (isHeading(line, body)) sizes.add(Math.round(line.size));
  }
  const ranked = [...sizes].sort((a, b) => b - a);
  return new Map(ranked.map((size, i) => [size, Math.min(i + 1, 3)]));
}

function isHeading(line: Line, body: number): boolean {
  return line.size >= body * 1.15 && line.text.length <= 120 && !PAGE_NUMBER.test(line.text);
}

function joinWrapped(paragraph: string, next: string): string {
  if (/[A-Za-zÀ-ÿ]-$/.test(paragraph) && /^[a-zà-ÿ]/.test(next)) return paragraph.slice(0, -1) + next;
  return `${paragraph} ${next}`;
}

export function pagesToMarkdown(pages: PageInput[]): MarkdownResult {
  const lines = pages.map((p) => buildLines(p.items));
  const body = bodySize(lines);
  const levels = headingLevels(lines, body);
  const isEdge = edgeTest(lines);
  const repeated = repeatedEdgeLines(lines, isEdge);
  const textlessPages: number[] = [];
  const out: string[] = [];

  pages.forEach((page, index) => {
    const pageLines = lines[index];
    out.push(`<!-- page ${page.number} -->`);
    if (pageLines.length === 0) {
      textlessPages.push(page.number);
      out.push('<!-- no text layer on this page (scanned image or figure): not converted -->', '');
      return;
    }

    const kept = pageLines.filter((line, i) => {
      if (PAGE_NUMBER.test(line.text) && isEdge(line, i, pageLines)) return false;
      return !(isEdge(line, i, pageLines) && repeated.has(normalizeEdge(line.text)));
    });

    let paragraph = '';
    let prev: Line | undefined;
    const flush = () => {
      if (paragraph) out.push(paragraph, '');
      paragraph = '';
    };

    for (const line of kept) {
      if (isHeading(line, body)) {
        flush();
        out.push(`${'#'.repeat(levels.get(Math.round(line.size)) ?? 3)} ${line.text}`, '');
        prev = undefined;
        continue;
      }

      const bullet = BULLET.exec(line.text);
      const gap = prev ? prev.y - line.y : 0;
      const newBlock = !prev || gap > Math.max(prev.size, line.size) * 1.8;
      if (bullet) {
        flush();
        // Numbered and lettered items keep their marker: "3." or "b)" often carries meaning (clause numbers).
        paragraph = /^[\da-z]/.test(bullet[1]) ? line.text : `- ${line.text.slice(bullet[0].length)}`;
      } else if (newBlock || !paragraph) {
        flush();
        paragraph = line.text;
      } else {
        paragraph = joinWrapped(paragraph, line.text);
      }
      prev = line;
    }
    flush();
  });

  const markdown = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(- .*)\n\n(?=- )/gm, '$1\n')
    .trim();
  return { markdown: markdown + '\n', textlessPages };
}
