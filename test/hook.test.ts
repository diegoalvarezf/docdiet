import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOrConvert } from '../src/cache.js';
import { handleHookInput, planRead } from '../src/hook.js';
import { estimatePdfTokens, pageImageTokens, pdfReadMode, readStats } from '../src/stats.js';
import { samplePdf, scannedPdf } from './fixtures.js';

let dir: string;
let sample: string;
let scanned: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'docdiet-test-'));
  process.env.DOCDIET_HOME = join(dir, 'home');
  sample = join(dir, 'report.pdf');
  scanned = join(dir, 'scan.pdf');
  writeFileSync(sample, await samplePdf());
  writeFileSync(scanned, await scannedPdf());
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DOCDIET_HOME;
});

describe('handleHookInput', () => {
  it('redirects a PDF Read to the cached Markdown', async () => {
    const output = await handleHookInput({ tool_name: 'Read', tool_input: { file_path: sample } });
    expect(output?.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output?.hookSpecificOutput.permissionDecision).toBe('allow');
    const mdPath = output!.hookSpecificOutput.updatedInput.file_path;
    expect(mdPath).toMatch(/report-[0-9a-f]{12}\.md$/);
    const markdown = readFileSync(mdPath, 'utf8');
    expect(markdown).toContain('# Annual Report');
    expect(markdown).toContain('Valencia');
    expect(markdown).not.toContain('Confidential');
  });

  it('resolves relative paths against cwd and records stats', async () => {
    const output = await handleHookInput({ tool_name: 'Read', tool_input: { file_path: 'report.pdf' }, cwd: dir });
    expect(output).not.toBeNull();
    const stats = await readStats();
    expect(stats.at(-1)?.cached).toBe(true);
    expect(stats.at(-1)!.markdownTokens).toBeLessThan(stats.at(-1)!.pdfTokens);
    expect(stats.at(-1)?.readMode).toBe('document');
  });

  it('forwards offset and limit, which now address Markdown lines', async () => {
    const output = await handleHookInput({ tool_name: 'Read', tool_input: { file_path: sample, offset: 5, limit: 3 } });
    expect(output?.hookSpecificOutput.updatedInput).toMatchObject({ offset: 5, limit: 3 });
    expect(output?.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  it('leaves small Markdown reads whole', async () => {
    const output = await handleHookInput({ tool_name: 'Read', tool_input: { file_path: sample } });
    expect(Object.keys(output!.hookSpecificOutput.updatedInput)).toEqual(['file_path']);
  });

  it('converts only the requested pages', async () => {
    const output = await handleHookInput({ tool_name: 'Read', tool_input: { file_path: sample, pages: '2' } });
    const markdown = readFileSync(output!.hookSpecificOutput.updatedInput.file_path, 'utf8');
    expect(markdown).toContain('Next Steps');
    expect(markdown).not.toContain('Annual Report');
  });

  it('leaves mostly scanned PDFs to Claude', async () => {
    expect(await handleHookInput({ tool_name: 'Read', tool_input: { file_path: scanned } })).toBeNull();
  });

  it('ignores other tools, other files, missing files and the cache itself', async () => {
    const { originalLink } = await getOrConvert(sample);
    expect(await handleHookInput({ tool_name: 'Edit', tool_input: { file_path: sample } })).toBeNull();
    expect(await handleHookInput({ tool_name: 'Read', tool_input: { file_path: join(dir, 'notes.txt') } })).toBeNull();
    expect(await handleHookInput({ tool_name: 'Read', tool_input: { file_path: join(dir, 'missing.pdf') } })).toBeNull();
    expect(await handleHookInput({ tool_name: 'Read', tool_input: { file_path: originalLink } })).toBeNull();
  });

  it('falls through on a broken PDF', async () => {
    const broken = join(dir, 'broken.pdf');
    writeFileSync(broken, 'not a pdf');
    expect(await handleHookInput({ tool_name: 'Read', tool_input: { file_path: broken } })).toBeNull();
  });
});

describe('planRead', () => {
  const page = (n: number) => `<!-- page ${n} -->\n\n${'Lorem ipsum dolor sit amet. '.repeat(40)}\n`;
  const markdown = Array.from({ length: 30 }, (_, i) => page(i + 1)).join('\n');

  it('does nothing when the Markdown fits in one Read', () => {
    expect(planRead(markdown, '/c/doc.md', 25_000)).toEqual({});
  });

  it('returns a first window and a page index when it does not fit', () => {
    const { limit, context } = planRead(markdown, '/c/doc.md', 2_000);
    const window = markdown.split('\n').slice(0, limit).join('\n');
    expect(window.length).toBeLessThanOrEqual(2_000 * 3);
    expect(limit).toBeGreaterThan(0);
    expect(context).toContain('/c/doc.md');
    expect(context).toContain(`lines 1-${limit}`);
    expect(context).toMatch(/p1:1 p2:\d+/);
  });

  it('windows anything over 256 KB even under the token cap', () => {
    const big = 'x'.repeat(100) + '\n';
    expect(planRead(big.repeat(3_000), '/c/doc.md', 1_000_000).limit).toBeGreaterThan(0);
  });
});

describe('PDF token estimate', () => {
  const a4 = { width: 595, height: 842 };

  it('matches how Claude Code would read the PDF', () => {
    expect(pdfReadMode(undefined, 10)).toBe('document');
    expect(pdfReadMode(undefined, 11)).toBe('images');
    expect(pdfReadMode('1-3', 5)).toBe('images');
  });

  it('prices a page image by 28 px patches at 100 DPI', () => {
    // 595×842 pt → 826×1169 px → 30×42 patches.
    expect(pageImageTokens(a4)).toBe(1260);
    // A poster gets shrunk to fit 2000×2000 first.
    expect(pageImageTokens({ width: 2880, height: 2880 })).toBe(72 * 72);
  });

  it('counts text only for whole-document reads', () => {
    const conversion = { rawTextChars: 4000, pageSizes: [a4, a4] };
    expect(estimatePdfTokens(conversion, 'images')).toBe(2520);
    expect(estimatePdfTokens(conversion, 'document')).toBe(3520);
  });
});
