import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOrConvert } from '../src/cache.js';
import { handleHookInput } from '../src/hook.js';
import { readStats } from '../src/stats.js';
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
