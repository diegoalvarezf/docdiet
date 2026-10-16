import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlePromptSubmit, pdfMentions } from '../src/prompt.js';
import { samplePdf, scannedPdf } from './fixtures.js';

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'docdiet-prompt-'));
  process.env.DOCDIET_HOME = join(dir, 'home');
  writeFileSync(join(dir, 'report.pdf'), await samplePdf());
  writeFileSync(join(dir, 'my scan.pdf'), await scannedPdf());
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DOCDIET_HOME;
});

describe('pdfMentions', () => {
  it('finds quoted and plain PDF mentions like Claude Code does', () => {
    expect(pdfMentions('Resume @docs/a.pdf, y compara con @"my scan.pdf" y @notes.md')).toEqual(['my scan.pdf', 'docs/a.pdf']);
    expect(pdfMentions('@b.pdf#L1-5 vs mail@host.pdf')).toEqual(['b.pdf']);
  });
});

describe('handlePromptSubmit', () => {
  it('inlines the Markdown of a short @-attached PDF', async () => {
    const output = await handlePromptSubmit({ prompt: 'Resume @report.pdf', cwd: dir });
    const context = output!.hookSpecificOutput.additionalContext;
    expect(output!.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(context).toContain('@report.pdf was attached without its content');
    expect(context).toContain('# Annual Report');
  });

  it('points scanned PDFs at the original pages', async () => {
    const output = await handlePromptSubmit({ prompt: 'Mira @"my scan.pdf"', cwd: dir });
    expect(output!.hookSpecificOutput.additionalContext).toMatch(/mostly scanned.*\.pdf with pages/);
  });

  it('stays silent without PDF mentions or with missing files', async () => {
    expect(await handlePromptSubmit({ prompt: 'hola @src/a.ts', cwd: dir })).toBeNull();
    expect(await handlePromptSubmit({ prompt: '@missing.pdf', cwd: dir })).toBeNull();
  });
});
