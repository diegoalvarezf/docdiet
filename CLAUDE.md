# docdiet — Claude Code Instructions

## Project overview
Claude Code `PreToolUse` hook on `Read`: converts PDFs to compact Markdown (cached) so agents spend fewer tokens.
100% local. Also the owner's neural-network learning project (phase 2) — explain NN steps as we go.

**Stack:** TypeScript, Node.js 22+, single package, pnpm. PDF text via `unpdf` (pdf.js). Tests: vitest, fixtures built with `pdf-lib`.

## Files

| File | Responsibility |
|------|---------------|
| `src/markdown.ts` | Pure: positioned text items → Markdown (lines, headings by font size, paragraphs, lists, de-hyphenation, running header/footer + page number removal, textless pages) |
| `src/convert.ts` | Reads the PDF with unpdf, page ranges (`parsePageRange`), calls `pagesToMarkdown` |
| `src/cache.ts` | `~/.docdiet/cache` (or `$DOCDIET_HOME`), key = realpath + size + mtime + pages + `CONVERTER_VERSION`; writes `.md`, `.json` meta and a `.pdf` symlink to the original |
| `src/hook.ts` | `handleHookInput` (pure-ish, testable) + `runHook` (stdin/stdout) |
| `src/install.ts` | Adds/removes our hook in Claude settings without touching others |
| `src/stats.ts` | Token estimates and `stats.jsonl` |
| `src/cli.ts` | `convert`, `install`, `uninstall`, `stats`, `hook` |

## Rules
- The hook must never block or break a Read: any error → exit 0 with no output (Claude reads the original).
- Paths inside the cache dir are never intercepted — that is how Claude can still open the original pages.
- Mostly scanned PDFs (≥ half the pages without text) pass through untouched.
- `updatedInput` replaces the whole tool input: send only `file_path` (drop `pages`, it was applied during conversion).
- Bump `CONVERTER_VERSION` whenever Markdown output changes.
- Pin new dependencies to versions published at least two weeks ago.
- No comments on obvious code — only on non-trivial logic.

## Commands
```bash
pnpm install
pnpm build
pnpm test
```

## Status
- Phase 1 done: hook, cache, fast text extraction, install/uninstall, stats.
- Phase 2 (next): page classifier (text / table / figure / scan) — fine-tune a small pretrained CNN (MobileNet/ResNet18)
  in PyTorch on DocLayNet / PubLayNet or synthetic PDFs, export to ONNX, run with `onnxruntime-node`. Then route:
  scans → OCR, tables → table extraction, two-column → column-aware reading order. Ask before downloading datasets.
