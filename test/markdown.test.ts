import { describe, expect, it } from 'vitest';
import { parsePageRange } from '../src/convert.js';
import { pagesToMarkdown, type TextItem } from '../src/markdown.js';

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
