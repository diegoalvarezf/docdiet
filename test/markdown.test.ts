import { describe, expect, it } from 'vitest';
import { parsePageRange } from '../src/convert.js';
import { findGutter, pagesToMarkdown, type TextItem } from '../src/markdown.js';

const item = (str: string, x: number, y: number, fontSize = 10): TextItem => ({
  str,
  x,
  y,
  width: str.length * fontSize * 0.5,
  fontSize,
});

describe('pagesToMarkdown', () => {
  it('turns bigger lines into headings, ranked by size', () => {
    const { markdown } = pagesToMarkdown([
      {
        number: 1,
        items: [
          item('Title', 50, 800, 24),
          item('Section', 50, 760, 16),
          item('Body text that is long enough to be the dominant size.', 50, 740),
        ],
      },
    ]);
    expect(markdown).toContain('# Title\n');
    expect(markdown).toContain('## Section\n');
    expect(markdown).toContain('Body text that is long enough');
  });

  it('joins wrapped lines into one paragraph and splits on vertical gaps', () => {
    const { markdown } = pagesToMarkdown([
      {
        number: 1,
        items: [item('first line of', 50, 700), item('the paragraph', 50, 688), item('second paragraph', 50, 640)],
      },
    ]);
    expect(markdown).toContain('first line of the paragraph\n\nsecond paragraph');
  });

  it('removes hyphenation across lines', () => {
    const { markdown } = pagesToMarkdown([{ number: 1, items: [item('an infor-', 50, 700), item('mation system', 50, 688)] }]);
    expect(markdown).toContain('an information system');
  });

  it('inserts spaces between separate word items on one line', () => {
    const { markdown } = pagesToMarkdown([{ number: 1, items: [item('hello', 50, 700), item('world', 80, 700)] }]);
    expect(markdown).toContain('hello world');
  });

  it('keeps list items together as a Markdown list', () => {
    const { markdown } = pagesToMarkdown([
      { number: 1, items: [item('• one', 50, 700), item('• two', 50, 688), item('3) three', 50, 676)] },
    ]);
    expect(markdown).toContain('- one\n- two\n\n3) three');
  });

  it('drops page numbers and running headers repeated on most pages', () => {
    const page = (n: number) => ({
      number: n,
      items: [item('ACME Corp report', 50, 820, 8), item(`Content of page ${n}`, 50, 700), item(String(n), 290, 30, 8)],
    });
    const { markdown } = pagesToMarkdown([page(1), page(2), page(3)]);
    expect(markdown).not.toContain('ACME');
    expect(markdown).not.toMatch(/^\d$/m);
    expect(markdown).toContain('Content of page 3');
  });

  it('flags pages without a text layer', () => {
    const result = pagesToMarkdown([
      { number: 1, items: [item('text', 50, 700)] },
      { number: 2, items: [] },
    ]);
    expect(result.textlessPages).toEqual([2]);
    expect(result.markdown).toContain('<!-- page 2 -->\n<!-- no text layer');
  });
});

describe('parsePageRange', () => {
  it('parses single pages, ranges and open ranges, clamped to the document', () => {
    expect(parsePageRange(undefined, 3)).toEqual([1, 2, 3]);
    expect(parsePageRange('2', 5)).toEqual([2]);
    expect(parsePageRange('1-3, 5', 10)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange('4-', 6)).toEqual([4, 5, 6]);
    expect(parsePageRange('8-20', 10)).toEqual([8, 9, 10]);
  });

  it('rejects garbage', () => {
    expect(() => parsePageRange('abc', 3)).toThrow();
  });
});

describe('running headers', () => {
  const page = (number: number, top: string) => ({
    number,
    items: [item(top, 50, 800), item(`Body text of page ${number} that is long enough to be body.`, 50, 700), item(`${number}`, 290, 40)],
  });

  it('keeps numbered section titles that repeat at the top of pages', () => {
    const { markdown } = pagesToMarkdown([1, 2, 3, 4].map((n) => page(n, `Ejercicio ${n * 2 - 1}`)));
    expect(markdown).toContain('Ejercicio 3');
    expect(markdown).toContain('Ejercicio 7');
  });

  it('still drops headers whose number follows the page', () => {
    const { markdown } = pagesToMarkdown([1, 2, 3, 4].map((n) => page(n, `Seite ${n + 13} von 24`)));
    expect(markdown).not.toContain('Seite');
  });
});

describe('two-column pages', () => {
  // Title across both columns, six lines per column side by side, a centred page footer.
  const columns = (): TextItem[] => [
    item('A Study of Layout', 200, 800, 16),
    ...Array.from({ length: 6 }, (_, i) => item(`left line ${i + 1} of the text`, 50, 760 - i * 12)),
    ...Array.from({ length: 6 }, (_, i) => item(`right line ${i + 1} of the text`, 310, 760 - i * 12)),
    item('Footer note spanning the whole width of the page', 150, 40),
  ];

  it('finds the gutter between the columns', () => {
    const gutter = findGutter(columns());
    expect(gutter).toBeGreaterThan(50 + 15 * 5);
    expect(gutter).toBeLessThan(310);
    expect(findGutter(Array.from({ length: 12 }, (_, i) => item('a full-width single column line of body text here', 50, 700 - i * 12)))).toBeUndefined();
  });

  it('reads the left column, then the right one, when the classifier says two columns', () => {
    const { markdown } = pagesToMarkdown([{ number: 1, items: columns(), labels: ['two_columns'] }]);
    const order = ['A Study of Layout', 'left line 1', 'left line 6', 'right line 1', 'right line 6', 'Footer note'];
    const positions = order.map((text) => markdown.indexOf(text));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(markdown).not.toContain('two-column page');
  });

  it('puts the gutter by the aligned right column even when left lines are ragged and split', () => {
    // Glossary style: bold term and definition are separate items, and left lines end anywhere.
    const items = Array.from({ length: 8 }, (_, i) => [
      item(`term${i}.`, 72, 700 - i * 12),
      item('x'.repeat(10 + ((i * 7) % 30)), 120, 700 - i * 12),
      item(`right entry ${i} with its definition`, 320, 700 - i * 12),
    ]).flat();
    const gutter = findGutter(items)!;
    expect(gutter).toBeGreaterThan(120 + 39 * 5);
    expect(gutter).toBeLessThan(320);
  });

  it('keeps the old row order without the label', () => {
    const { markdown } = pagesToMarkdown([{ number: 1, items: columns() }]);
    expect(markdown).toContain('left line 1 of the text right line 1 of the text');
  });
});
