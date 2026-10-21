import type { TextItem } from './markdown.js';

// Table recovery from text positions, used on pages the classifier says have a table.
// A table shows up as a run of rows split into cells by gaps wider than word spacing, whose
// cells line up into columns: the x ranges no cell of the run touches separate the columns.

export interface Table {
  // Row indexes (inclusive) of the run of rows the table replaces.
  first: number;
  last: number;
  cells: string[][];
}

interface Span {
  text: string;
  x0: number;
  x1: number;
}

interface Cell extends Span {
  // The items it was joined from, to split it again if it turns out to cross columns.
  parts: Span[];
}

const MIN_ROWS = 3;
// Gap between items, in em, that separates cells; word spacing is ~0.25-0.5 em.
const CELL_GAP_EM = 1.2;
// Vertical gap, in font sizes, that ends a table (table rows are often widely spaced).
const MAX_ROW_GAP = 4;

function splitCells(row: TextItem[]): Cell[] {
  const cells: Cell[] = [];
  for (const item of [...row].filter((i) => i.str.trim()).sort((a, b) => a.x - b.x)) {
    const last = cells[cells.length - 1];
    const gap = last ? item.x - last.x1 : Infinity;
    const span = { text: item.str.trim(), x0: item.x, x1: item.x + item.width };
    if (last && gap <= Math.max(item.fontSize, 1) * CELL_GAP_EM) {
      last.text += (gap > item.fontSize * 0.15 ? ' ' : '') + span.text;
      last.x1 = Math.max(last.x1, span.x1);
      last.parts.push(span);
    } else {
      cells.push({ ...span, parts: [span] });
    }
  }
  return cells;
}

// Column boundaries: x ranges covered by the cells of the fullest rows, so headers spanning several
// columns and rows with empty cells do not merge columns. "Fullest" is the largest cell count that
// enough rows share, so one stray split does not invent a column.
function columns(rows: Cell[][]): { x0: number; x1: number }[] {
  const split = rows.filter((r) => r.length >= 2);
  const counts = new Map<number, number>();
  for (const row of split) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  const support = Math.max(2, split.length * 0.25);
  const typical = [...counts].filter(([, n]) => n >= support).sort((a, b) => b[0] - a[0])[0]?.[0];
  if (typical === undefined) return [];
  const intervals = split
    .filter((r) => r.length === typical)
    .flat()
    .map((c) => ({ x0: c.x0, x1: c.x1 }))
    .sort((a, b) => a.x0 - b.x0);
  const merged: { x0: number; x1: number }[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.x0 <= last.x1) last.x1 = Math.max(last.x1, interval.x1);
    else merged.push({ ...interval });
  }
  return merged;
}

function nearestColumn(span: Span, cols: { x0: number; x1: number }[]): number {
  // The column it overlaps most; a span in a gap goes to the nearest column.
  let best = 0;
  let bestScore = -Infinity;
  cols.forEach((col, i) => {
    const overlap = Math.min(span.x1, col.x1) - Math.max(span.x0, col.x0);
    const score = overlap > 0 ? overlap : -Math.min(Math.abs(span.x0 - col.x1), Math.abs(col.x0 - span.x1));
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

function place(row: Cell[], cols: { x0: number; x1: number }[]): string[] {
  const out = cols.map(() => '');
  const put = (i: number, text: string) => (out[i] = out[i] ? `${out[i]} ${text}` : text);
  for (const cell of row) {
    // Headers are often set tighter than the data: a cell crossing columns is split back into its items.
    const crossed = cols.filter((col) => Math.min(cell.x1, col.x1) > Math.max(cell.x0, col.x0)).length;
    if (crossed > 1 && cell.parts.length > 1) for (const part of cell.parts) put(nearestColumn(part, cols), part.text);
    else put(nearestColumn(cell, cols), cell.text);
  }
  return out;
}

// Stacked fractions also split into "cells": math letters (𝑉, 𝐼, 𝑅) or bare operators in many cells
// mean a formula, not a table.
const MATH_LETTER = /[\u{1D400}-\u{1D7FF}]/u;
const OPERATOR_CELL = /^[=+\-−·×÷/<>≤≥≈]+$|^=|=$/;
const MAX_FORMULA_CELLS = 0.3;

function looksLikeFormula(rows: string[][]): boolean {
  const cells = rows.flat().filter(Boolean);
  const formulas = cells.filter((c) => MATH_LETTER.test(c) || OPERATOR_CELL.test(c));
  return formulas.length >= cells.length * MAX_FORMULA_CELLS;
}

// A list with a wide indent also splits into a marker column and a text column.
const LIST_MARKER = /^([•◦▪‣∙·●○■□–*v-]|\d{1,3}[.)]|[a-z][.)]|\(\w{1,3}\))$/;

function toTable(rows: Cell[][]): string[][] | undefined {
  const cols = columns(rows);
  if (cols.length < 2) return undefined;
  if (cols.length === 2 && rows.every((r) => r.length < 2 || LIST_MARKER.test(r[0].text))) return undefined;
  const table: string[][] = [];
  for (const row of rows) {
    const cells = place(row, cols);
    // A row with an empty first column continues the cells of the row above (wrapped text).
    const previous = table[table.length - 1];
    if (previous && !cells[0] && cells.filter(Boolean).length < cols.length) {
      cells.forEach((text, i) => {
        if (text) previous[i] = previous[i] ? `${previous[i]} ${text}` : text;
      });
    } else {
      table.push(cells);
    }
  }
  return table.length >= 2 && !looksLikeFormula(table) ? table : undefined;
}

export function findTables(rows: TextItem[][]): Table[] {
  const cells = rows.map(splitCells);
  const tables: Table[] = [];
  // The open run: first row, last row accepted into it, and the horizontal extent of its split rows.
  let start = -1;
  let last = -1;
  let runX0 = Infinity;
  let runX1 = -Infinity;
  const close = () => {
    if (start >= 0 && last - start + 1 >= MIN_ROWS) {
      const table = toTable(cells.slice(start, last + 1));
      if (table) tables.push({ first: start, last, cells: table });
    }
    start = -1;
  };

  for (let i = 0; i < rows.length; i++) {
    const split = cells[i].length >= 2;
    const size = Math.max(...rows[i].map((item) => item.fontSize), 1);
    const gap = i > 0 ? rows[i - 1][0].y - rows[i][0].y : 0;
    if (start >= 0 && gap > size * MAX_ROW_GAP) close();
    if (start >= 0 && !split) {
      // A cell wrapped onto its own line sits right of the first column or is narrow; running
      // text after a table starts at the margin and spans it.
      const cell = cells[i][0];
      const wrapped = cell && (cell.x0 > runX0 + size * 2 || cell.x1 - cell.x0 < (runX1 - runX0) * 0.5);
      if (wrapped) last = i;
      else close();
    }
    if (!split) continue;
    if (start < 0) {
      start = i;
      runX0 = Infinity;
      runX1 = -Infinity;
    }
    last = i;
    runX0 = Math.min(runX0, cells[i][0].x0);
    runX1 = Math.max(runX1, cells[i][cells[i].length - 1].x1);
  }
  close();
  return tables;
}

export function tableToMarkdown(cells: string[][]): string {
  const escape = (text: string) => text.replace(/\|/g, '\\|');
  const width = Math.max(...cells.map((r) => r.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => escape(row[i] ?? '')).join(' | ')} |`;
  return [line(cells[0]), `|${' --- |'.repeat(width)}`, ...cells.slice(1).map(line)].join('\n');
}
