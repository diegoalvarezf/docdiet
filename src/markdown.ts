export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

import { findTables, tableToMarkdown } from './tables.js';

export interface PageInput {
  number: number;
  items: TextItem[];
  // From the page classifier: what the text alone does not carry well.
  labels?: string[];
}

const LABEL_NOTES: Record<string, string> = {
  table: 'table on this page: cell layout may be lost, check the original page if exact values matter',
  table_rebuilt: 'table on this page rebuilt from text positions: check the original page if exact values matter',
  figure: 'figure on this page: not in the Markdown, see the original page',
  two_columns: 'two-column page: columns not separated, text order may mix them',
};

export interface MarkdownResult {
  markdown: string;
  textlessPages: number[];
}

interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
  // Already-rendered Markdown table standing in for several rows.
  table?: boolean;
}

const BULLET = /^([•◦▪‣∙·●○■□–-]|\*|\d{1,3}[.)]|[a-z][.)])\s+/;
const PAGE_NUMBER = /^(page\s*)?\d{1,4}(\s*(of|\/|de)\s*\d{1,4})?$/i;

function groupRows(items: TextItem[]): TextItem[][] {
  const sorted = items.filter((i) => i.str.length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    const tolerance = Math.max(item.fontSize, 1) * 0.5;
    if (row && Math.abs(row[0].y - item.y) <= tolerance) row.push(item);
    else rows.push([item]);
  }
  return rows;
}

function rowToLine(row: TextItem[]): Line | undefined {
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
  if (!text) return undefined;
  return { text, x: row[0].x, y: row[0].y, size: sizeWeight ? sizeSum / sizeWeight : row[0].fontSize };
}

// The gutter is the x in the middle band of the page that the fewest text items cover.
// Returns undefined when nothing looks like a gutter or one side is nearly empty.
export function findGutter(items: TextItem[]): number | undefined {
  const text = items.filter((i) => i.str.trim().length > 0);
  if (text.length < 10) return undefined;
  const left = Math.min(...text.map((i) => i.x));
  const right = Math.max(...text.map((i) => i.x + i.width));
  const span = right - left;
  if (span <= 0) return undefined;

  const from = Math.floor(left + span * 0.3);
  const to = Math.ceil(left + span * 0.7);
  const coverage = new Array<number>(to - from + 1).fill(0);
  for (const item of text) {
    for (let x = Math.max(from, Math.ceil(item.x)); x <= Math.min(to, Math.floor(item.x + item.width)); x++) coverage[x - from]++;
  }
  const least = Math.min(...coverage);
  // A real gutter is crossed only by the odd full-width title or footer.
  if (least > text.length * 0.1) return undefined;

  let best = { start: 0, length: 0 };
  for (let i = 0; i < coverage.length; ) {
    if (coverage[i] !== least) {
      i++;
      continue;
    }
    let j = i;
    while (j < coverage.length && coverage[j] === least) j++;
    if (j - i > best.length) best = { start: i, length: j - i };
    i = j;
  }
  const gap = from + best.start + best.length / 2;
  const leftItems = text.filter((i) => i.x + i.width <= gap);
  const rightItems = text.filter((i) => i.x >= gap);
  if (Math.min(leftItems.length, rightItems.length) < text.length * 0.2) return undefined;
  // The emptiest x can sit beside a short title instead of between the columns. The right column's
  // left edge is aligned (the left one is ragged: lines end anywhere), so put the gutter just before it.
  const starts = rightItems.map((i) => i.x).sort((a, b) => a - b);
  return starts[Math.floor(starts.length / 4)] - 3;
}

// Reading order for a two-column page: rows crossing the gutter (titles, footers) cut the page into
// stretches, and each stretch is read left column first, then right column.
function columnRows(items: TextItem[], gutter: number): TextItem[][] {
  const ordered: TextItem[][] = [];
  let leftRows: TextItem[][] = [];
  let rightRows: TextItem[][] = [];
  const flush = () => {
    ordered.push(...leftRows, ...rightRows);
    leftRows = [];
    rightRows = [];
  };
  for (const row of groupRows(items)) {
    // pdf.js emits whitespace items that can stretch across the gutter; only real text spans it.
    if (row.some((i) => i.str.trim() && i.x < gutter - 1 && i.x + i.width > gutter + 1)) {
      flush();
      ordered.push(row);
      continue;
    }
    const leftPart = row.filter((i) => i.str.trim() && i.x + i.width / 2 < gutter);
    const rightPart = row.filter((i) => i.str.trim() && i.x + i.width / 2 >= gutter);
    if (leftPart.length) leftRows.push(leftPart);
    if (rightPart.length) rightRows.push(rightPart);
  }
  flush();
  return ordered;
}

interface BuiltPage {
  lines: Line[];
  reordered: boolean;
  tables: number;
}

function buildLines(items: TextItem[], twoColumns = false, hasTable = false): BuiltPage {
  const gutter = twoColumns ? findGutter(items) : undefined;
  const rows = gutter === undefined ? groupRows(items) : columnRows(items, gutter);
  const tables = hasTable ? findTables(rows) : [];
  const lines: Line[] = [];
  for (let i = 0; i < rows.length; i++) {
    const table = tables.find((t) => t.first === i);
    if (table) {
      const first = rows[i][0];
      lines.push({ text: tableToMarkdown(table.cells), x: first.x, y: first.y, size: first.fontSize, table: true });
      i = table.last;
      continue;
    }
    const line = rowToLine(rows[i]);
    if (line) lines.push(line);
  }
  return { lines, reordered: gutter !== undefined, tables: tables.length };
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
  const built = pages.map((p) => buildLines(p.items, p.labels?.includes('two_columns'), p.labels?.includes('table')));
  const lines = built.map((b) => b.lines);
  const body = bodySize(lines);
  const levels = headingLevels(lines, body);
  const isEdge = edgeTest(lines);
  const repeated = repeatedEdgeLines(lines, isEdge);
  const textlessPages: number[] = [];
  const out: string[] = [];

  pages.forEach((page, index) => {
    const pageLines = lines[index];
    out.push(`<!-- page ${page.number} -->`);
    for (const label of page.labels ?? []) {
      // Columns already put in reading order need no warning.
      if (label === 'two_columns' && built[index].reordered) continue;
      const note = label === 'table' && built[index].tables > 0 ? LABEL_NOTES.table_rebuilt : LABEL_NOTES[label];
      if (note) out.push(`<!-- ${note} -->`);
    }
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
      if (line.table) {
        flush();
        out.push(line.text, '');
        prev = undefined;
        continue;
      }
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
