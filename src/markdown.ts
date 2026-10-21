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
  // Set when the items came from OCR of a scanned page (mean word confidence, 0-100).
  ocrConfidence?: number;
  // Mostly an image (handwriting, diagram, screenshot): the few words here are not its content.
  visual?: boolean;
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
  // Already-rendered Markdown (a table or a laid-out formula) standing in for several rows.
  raw?: boolean;
}

const BULLET = /^([•◦▪‣∙·●○■□–-]|\*|\d{1,3}[.)]|[a-z][.)])\s+/;
const PAGE_NUMBER = /^(page\s*)?\d{1,4}(\s*(of|\/|de)\s*\d{1,4})?$/i;

function groupRows(items: TextItem[]): TextItem[][] {
  const sorted = items.filter((i) => i.str.length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    // Compare with the row's main text, not its first item: a superscript sorts first.
    const main = row?.reduce((a, b) => (b.fontSize > a.fontSize ? b : a));
    const tolerance = Math.max(item.fontSize, main?.fontSize ?? 0, 1) * 0.5;
    if (row && main && Math.abs(main.y - item.y) <= tolerance) row.push(item);
    else rows.push([item]);
  }
  return rows;
}

// Sub- and superscripts (R_eq1, e^x, 10^-27) are smaller items off the row's baseline; written
// inline they read as separate words ("R eq1", "e x" = e·x), so they get a _ or ^ marker.
function scriptMarker(item: TextItem, row: TextItem[]): string {
  const main = Math.max(...row.map((i) => i.fontSize));
  if (item.fontSize > main * 0.85) return '';
  const base = row.filter((i) => i.fontSize >= main * 0.9).map((i) => i.y);
  const dy = item.y - base.reduce((a, b) => a + b, 0) / Math.max(1, base.length);
  if (dy > main * 0.15) return '^';
  if (dy < -main * 0.1) return '_';
  return '';
}

function scripted(item: TextItem, row: TextItem[]): { text: string; attached: boolean } {
  const text = item.str.trim();
  const marker = text ? scriptMarker(item, row) : '';
  if (!marker) return { text: item.str, attached: false };
  return { text: `${marker}${[...text].length > 1 ? `{${text}}` : text}`, attached: true };
}

function rowToLine(row: TextItem[]): Line | undefined {
  row.sort((a, b) => a.x - b.x);
  let text = '';
  let end = -Infinity;
  let sizeWeight = 0;
  let sizeSum = 0;
  for (const item of row) {
    const piece = scripted(item, row);
    // pdf.js splits words into separate items; a visible gap means a space
    const gap = item.x - end;
    if (text && !piece.attached && gap > item.fontSize * 0.15 && !/\s$/.test(text) && !/^\s/.test(piece.text)) text += ' ';
    text += piece.text;
    end = item.x + item.width;
    const chars = item.str.trim().length;
    sizeSum += item.fontSize * chars;
    sizeWeight += chars;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return { text, x: row[0].x, y: row[0].y, size: sizeWeight ? sizeSum / sizeWeight : row[0].fontSize };
}

const MATH_LETTER = /[\u{1D400}-\u{1D7FF}]/u;

// A formula set in 2D (stacked fractions) is a few rows closer together than lines of text, at
// least one with math letters. Returns [first, last] row index pairs.
function formulaRuns(rows: TextItem[][]): [number, number][] {
  const size = (row: TextItem[]) => Math.max(...row.map((i) => i.fontSize), 1);
  const baseline = (row: TextItem[]) => row.reduce((a, b) => (b.fontSize > a.fontSize ? b : a)).y;
  const runs: [number, number][] = [];
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    const tight = i < rows.length && baseline(rows[i - 1]) - baseline(rows[i]) < Math.max(size(rows[i - 1]), size(rows[i])) * 0.95;
    if (tight) continue;
    const run = rows.slice(start, i);
    if (run.length >= 2 && run.some((row) => row.some((item) => MATH_LETTER.test(item.str)))) runs.push([start, i - 1]);
    start = i;
  }
  return runs;
}

// Lays the rows out in a code block, each item at its own column, so numerators stay above
// denominators the way pdftotext -layout keeps them.
function layoutBlock(rows: TextItem[][]): string {
  const items = rows.flat().filter((i) => i.str.trim());
  const left = Math.min(...items.map((i) => i.x));
  const sizes = items.map((i) => i.fontSize).sort((a, b) => a - b);
  const charWidth = sizes[Math.floor(sizes.length / 2)] * 0.5;
  const lines = rows.map((row) => {
    const chars: string[] = [];
    for (const item of [...row].filter((i) => i.str.trim()).sort((a, b) => a.x - b.x)) {
      const piece = scripted(item, row);
      const text = [...piece.text.trim()];
      // Scripts stick to what they belong to; other pieces go to their column, never overlapping
      // what is already written and keeping one space between pieces.
      const col = piece.attached
        ? chars.length
        : Math.max(Math.round((item.x - left) / charWidth), chars.length === 0 ? 0 : chars.length + 1);
      while (chars.length < col) chars.push(' ');
      chars.push(...text);
    }
    return chars.join('').trimEnd();
  });
  return ['```', ...lines, '```'].join('\n');
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
  const formulas = formulaRuns(rows);
  const inFormula = (first: number, last: number) => formulas.some(([a, b]) => first <= b && last >= a);
  const tables = hasTable ? findTables(rows).filter((t) => !inFormula(t.first, t.last)) : [];
  const lines: Line[] = [];
  for (let i = 0; i < rows.length; i++) {
    const first = rows[i][0];
    const table = tables.find((t) => t.first === i);
    if (table) {
      lines.push({ text: tableToMarkdown(table.cells), x: first.x, y: first.y, size: first.fontSize, raw: true });
      i = table.last;
      continue;
    }
    const formula = formulas.find(([a]) => a === i);
    if (formula) {
      lines.push({ text: layoutBlock(rows.slice(formula[0], formula[1] + 1)), x: first.x, y: first.y, size: first.fontSize, raw: true });
      i = formula[1];
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
  const seen = new Map<string, { page: number; text: string }[]>();
  let withText = 0;
  pages.forEach((lines, page) => {
    if (lines.length === 0) return;
    withText++;
    const edges = new Map(lines.filter(isEdge).map((l) => [normalizeEdge(l.text), l.text]));
    for (const [key, text] of edges) seen.set(key, [...(seen.get(key) ?? []), { page, text }]);
  });
  const minPages = Math.max(2, Math.ceil(withText * 0.5));
  return new Set([...seen].filter(([, hits]) => hits.length >= minPages && isRunning(hits)).map(([key]) => key));
}

// Repeated text with numbers is a running header only when it is identical everywhere or one of its
// numbers follows the page ("Seite 14 von 24"); "Ejercicio 1", "Ejercicio 2"... are section titles.
function isRunning(hits: { page: number; text: string }[]): boolean {
  if (hits.every((h) => h.text === hits[0].text)) return true;
  const numbers = hits.map((h) => (h.text.match(/\d+/g) ?? []).map(Number));
  const slots = Math.min(...numbers.map((n) => n.length));
  for (let k = 0; k < slots; k++) {
    const offset = numbers[0][k] - hits[0].page;
    if (numbers.every((n, i) => n[k] - hits[i].page === offset)) return true;
  }
  return false;
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
    if (page.visual) {
      out.push('<!-- page mostly an image (diagram, photo, screenshot or handwriting): its content is not in this Markdown, see the original page -->');
    }
    if (page.ocrConfidence !== undefined) {
      out.push(`<!-- scanned page, text from OCR (confidence ${Math.round(page.ocrConfidence)}%): check the original page if exact wording matters -->`);
    }
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
      // Headings are never running headers, even when their number matches the page ("Chapter 2").
      return !(isEdge(line, i, pageLines) && repeated.has(normalizeEdge(line.text)) && !isHeading(line, body));
    });

    let paragraph = '';
    let prev: Line | undefined;
    const flush = () => {
      if (paragraph) out.push(paragraph, '');
      paragraph = '';
    };

    for (const line of kept) {
      if (line.raw) {
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
