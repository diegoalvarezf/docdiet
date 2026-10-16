import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDocumentProxy } from 'unpdf';
import { afterEach, describe, expect, it } from 'vitest';
import { labelsOf, pageProbabilities } from '../src/classify.js';
import { convertPdf } from '../src/convert.js';
import { layoutPdf } from './fixtures.js';

describe('page classifier', () => {
  it('recognizes two columns, a table and a figure, and nothing on plain text', async () => {
    const pdf = await getDocumentProxy(await layoutPdf());
    const probabilities = await pageProbabilities(pdf, [1, 2, 3, 4]);
    expect([1, 2, 3, 4].map((page) => labelsOf(probabilities.get(page)!))).toEqual([
      ['two_columns'],
      ['table'],
      ['figure'],
      [],
    ]);
  });
});

describe('conversion with the classifier', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'docdiet-classify-')), 'layout.pdf');

  afterEach(() => {
    delete process.env.DOCDIET_CLASSIFY;
  });

  it('notes what the text alone does not carry', async () => {
    writeFileSync(file, await layoutPdf());
    const { markdown, pageLabels } = await convertPdf(file);
    expect(pageLabels).toEqual({ 1: ['two_columns'], 2: ['table'], 3: ['figure'] });
    expect(markdown).toContain('<!-- page 2 -->\n<!-- table on this page');
    expect(markdown).toContain('<!-- figure on this page');
    // The two-column page is put in reading order, so it needs no warning.
    expect(markdown).not.toContain('two-column page');
  });

  it('can be turned off', async () => {
    writeFileSync(file, await layoutPdf());
    process.env.DOCDIET_CLASSIFY = '0';
    const { markdown, pageLabels } = await convertPdf(file);
    expect(pageLabels).toEqual({});
    expect(markdown).not.toContain('on this page');
  });
});
