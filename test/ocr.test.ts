import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertPdf } from '../src/convert.js';
import { tesseractAvailable, tsvToItems } from '../src/ocr.js';
import { scannedTextPdf } from './fixtures.js';

const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

describe('tsvToItems', () => {
  it('turns word boxes into positioned items in PDF points, sized by their line', () => {
    const tsv = [
      header,
      '4\t1\t1\t1\t1\t0\t100\t200\t400\t60\t-1\t',
      '5\t1\t1\t1\t1\t1\t100\t210\t150\t40\t95.5\tHello',
      '5\t1\t1\t1\t1\t2\t270\t210\t230\t40\t80\tworld!',
      '5\t1\t1\t1\t1\t3\t510\t210\t10\t40\t-1\t ',
    ].join('\n');
    const { items, confidence } = tsvToItems(tsv, 842, 300 / 72);
    expect(items).toHaveLength(2);
    expect(items[0].str).toBe('Hello');
    expect(items[0].x).toBeCloseTo(24);
    expect(items[0].y).toBeCloseTo(842 - 260 * (72 / 300));
    expect(items[1].y).toBe(items[0].y);
    expect(items[0].fontSize).toBeCloseTo((60 * 72) / 300 / 1.2);
    // Weighted by characters: (95.5 * 5 + 80 * 6) / 11
    expect(confidence).toBeCloseTo(87.05, 1);
  });
});

describe('OCR of scanned pages', async () => {
  const hasTesseract = await tesseractAvailable();

  it.skipIf(!hasTesseract)('reads a scanned page into Markdown with a note', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'docdiet-ocr-')), 'scan.pdf');
    writeFileSync(file, await scannedTextPdf());
    const { markdown, ocrPages, textlessPages, rawTextChars } = await convertPdf(file);
    expect(ocrPages).toEqual([1]);
    expect(textlessPages).toEqual([]);
    expect(rawTextChars).toBe(0);
    expect(markdown).toContain('text from OCR');
    expect(markdown).toMatch(/Annual Report/);
    expect(markdown).toContain('Revenue grew in every quarter');
    expect(markdown).toContain('Costs stayed flat');
  });

  it.skipIf(!hasTesseract)('can be turned off', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'docdiet-ocr-')), 'scan.pdf');
    writeFileSync(file, await scannedTextPdf());
    process.env.DOCDIET_OCR = '0';
    try {
      expect((await convertPdf(file)).textlessPages).toEqual([1]);
    } finally {
      delete process.env.DOCDIET_OCR;
    }
  });
});
