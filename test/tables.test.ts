import { describe, expect, it } from 'vitest';
import type { TextItem } from '../src/markdown.js';
import { findTables, tableToMarkdown } from '../src/tables.js';

const item = (str: string, x: number, y: number, fontSize = 10): TextItem => ({
  str,
  x,
  y,
  width: str.length * fontSize * 0.5,
  fontSize,
});

// Rows the way markdown.ts groups them: top to bottom.
const rows = (...lines: TextItem[][]) => lines;

describe('findTables', () => {
  it('rebuilds columns, keeps the table apart from the running text around it', () => {
    const found = findTables(
      rows(
        [item('Some running text that introduces the table below it.', 50, 720)],
        [item('Code', 50, 700), item('Name', 120, 700), item('Price', 300, 700)],
        [item('A1', 50, 686), item('Widget', 120, 686), item('3,50', 300, 686)],
        [item('B2', 50, 672), item('Gadget', 120, 672), item('12,00', 300, 672)],
        [item('C3', 50, 658), item('Thing', 120, 658), item('0,99', 300, 658)],
        [item('More running text after the table, spanning the whole width.', 50, 630)],
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ first: 1, last: 4 });
    expect(found[0].cells).toEqual([
      ['Code', 'Name', 'Price'],
      ['A1', 'Widget', '3,50'],
      ['B2', 'Gadget', '12,00'],
      ['C3', 'Thing', '0,99'],
    ]);
  });

  it('joins cells wrapped onto following lines', () => {
    const [table] = findTables(
      rows(
        [item('1', 50, 700), item('Short', 120, 700), item('10', 300, 700)],
        [item('2', 50, 686), item('A long description that', 120, 686), item('20', 300, 686)],
        [item('wraps onto two', 120, 676)],
        [item('more lines', 120, 666)],
        [item('3', 50, 652), item('Last', 120, 652), item('30', 300, 652)],
      ),
    );
    expect(table.cells).toEqual([
      ['1', 'Short', '10'],
      ['2', 'A long description that wraps onto two more lines', '20'],
      ['3', 'Last', '30'],
    ]);
  });

  it('splits a tightly set header back into the data columns', () => {
    const [table] = findTables(
      rows(
        [item('Opt', 50, 700), item('Field', 70, 700), item('Length', 130, 700), item('Type', 170, 700)],
        [item('x', 50, 686), item('NAME', 80, 686), item('15', 135, 686), item('C', 175, 686)],
        [item('x', 50, 672), item('CODE', 80, 672), item('8', 135, 672), item('C', 175, 672)],
      ),
    );
    expect(table.cells[0]).toEqual(['Opt', 'Field', 'Length', 'Type']);
  });

  it('does not take a widely indented list for a table', () => {
    const list = rows(
      [item('•', 50, 700), item('First item of the list', 80, 700)],
      [item('•', 50, 686), item('Second item of the list', 80, 686)],
      [item('2)', 50, 672), item('Third item of the list', 80, 672)],
    );
    expect(findTables(list)).toEqual([]);
  });

  it('does not take stacked fractions for a table', () => {
    const fraction = rows(
      [item('𝑉1', 150, 700), item('7,2', 250, 700)],
      [item('𝐼1 =', 100, 690), item('=', 200, 690), item('= 3,25 𝑚𝐴', 300, 690)],
      [item('𝑅𝑒𝑞1', 150, 680), item('2222,22', 250, 680)],
    );
    expect(findTables(fraction)).toEqual([]);
  });

  it('ignores plain paragraphs', () => {
    const text = rows(
      [item('A paragraph of text with normal word spacing only.', 50, 700)],
      [item('Another line of the same paragraph goes here.', 50, 688)],
      [item('And a third one to be sure.', 50, 676)],
    );
    expect(findTables(text)).toEqual([]);
  });
});

describe('tableToMarkdown', () => {
  it('writes a header, a separator and escaped cells', () => {
    expect(tableToMarkdown([['a', 'b|c'], ['1', '2']])).toBe('| a | b\\|c |\n| --- | --- |\n| 1 | 2 |');
  });
});
