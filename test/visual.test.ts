import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertPdf } from '../src/convert.js';
import { handleHookInput } from '../src/hook.js';
import { slidesPdf } from './fixtures.js';

describe('pages that are mostly an image', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docdiet-visual-'));
  process.env.DOCDIET_HOME = join(dir, 'home');
  const file = join(dir, 'slides.pdf');

  it('flags diagram slides but not text slides, and says so in the Markdown', async () => {
    writeFileSync(file, await slidesPdf());
    const { visualPages, markdown } = await convertPdf(file);
    expect(visualPages).toEqual([1, 2]);
    expect(markdown.match(/page mostly an image/g)).toHaveLength(2);
  });

  it('leaves a PDF that is mostly images to Claude', async () => {
    writeFileSync(file, await slidesPdf());
    expect(await handleHookInput({ tool_name: 'Read', tool_input: { file_path: file } })).toBeNull();
  });
});
