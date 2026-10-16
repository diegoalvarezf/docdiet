#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getOrConvert } from './cache.js';
import { convertPdf } from './convert.js';
import { runHook } from './hook.js';
import { hookCommand, install, settingsPath, stableNodePath, uninstall } from './install.js';
import { estimatePdfTokens, estimateTokens, pdfReadMode, readStats } from './stats.js';

const USAGE = `docdiet — PDFs as compact Markdown for AI coding agents

Usage:
  docdiet convert <file.pdf> [--pages 1-5] [-o out.md]   print (or write) the Markdown
  docdiet install [--project]                            add the Claude Code hook (default: ~/.claude/settings.json)
  docdiet uninstall [--project]                          remove it
  docdiet stats                                          tokens saved so far (estimated)
  docdiet hook                                           (used by Claude Code)`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      pages: { type: 'string' },
      output: { type: 'string', short: 'o' },
      project: { type: 'boolean' },
      'no-cache': { type: 'boolean' },
    },
  });
  const scope = values.project ? 'project' : 'user';

  switch (command) {
    case 'hook':
      return runHook();

    case 'convert': {
      const file = positionals[0];
      if (!file) throw new Error('missing <file.pdf>');
      const conversion = values['no-cache']
        ? await convertPdf(file, values.pages)
        : (await getOrConvert(file, values.pages)).conversion;
      if (values.output) await writeFile(values.output, conversion.markdown);
      else process.stdout.write(conversion.markdown);
      const pdf = estimatePdfTokens(conversion, pdfReadMode(values.pages, conversion.totalPages));
      const md = estimateTokens(conversion.markdown);
      const scanned = conversion.textlessPages.length ? `, ${conversion.textlessPages.length} without text` : '';
      process.stderr.write(
        `\n${conversion.convertedPages.length} pages${scanned} · ~${md} tokens instead of ~${pdf} (${percent(md, pdf)} saved)\n`,
      );
      return;
    }

    case 'install': {
      const path = settingsPath(scope);
      const cli = realpathSync(fileURLToPath(import.meta.url));
      await install(path, hookCommand(stableNodePath(), cli));
      console.log(`Hook installed in ${path}.\nClaude Code will now read PDFs as Markdown (restart open sessions).`);
      return;
    }

    case 'uninstall': {
      const path = settingsPath(scope);
      console.log((await uninstall(path)) ? `Hook removed from ${path}.` : `No docdiet hook in ${path}.`);
      return;
    }

    case 'stats': {
      const stats = await readStats();
      if (stats.length === 0) {
        console.log('No PDFs converted through the hook yet.');
        return;
      }
      const pdf = stats.reduce((s, e) => s + e.pdfTokens, 0);
      const md = stats.reduce((s, e) => s + e.markdownTokens, 0);
      console.log(`${stats.length} PDF reads · ~${md.toLocaleString()} tokens instead of ~${pdf.toLocaleString()}`);
      console.log(`~${(pdf - md).toLocaleString()} tokens saved (${percent(md, pdf)}), estimated`);
      return;
    }

    default:
      console.log(USAGE);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

function percent(markdown: number, pdf: number): string {
  return pdf > 0 ? `${Math.round((1 - markdown / pdf) * 100)}%` : '0%';
}

main().catch((error: unknown) => {
  console.error(`docdiet: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
