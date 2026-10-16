# docdiet — Claude Code Instructions

## Project overview
Claude Code `PreToolUse` hook on `Read`: converts PDFs to compact Markdown (cached) so agents spend fewer tokens.
100% local. Also the owner's neural-network learning project (phase 2) — explain NN steps as we go.

**Stack:** TypeScript, Node.js 22+, single package, pnpm. PDF text via `unpdf` (pdf.js). Tests: vitest, fixtures built with `pdf-lib`.

## Files

| File | Responsibility |
|------|---------------|
| `src/markdown.ts` | Pure: positioned text items → Markdown (lines, headings by font size, paragraphs, lists, de-hyphenation, running header/footer + page number removal, textless pages, column order on pages labelled two-column) |
| `src/classify.ts` | Page classifier: renders pages to 224×320 gray (pdf.js + `@napi-rs/canvas`), runs `models/page-classifier.onnx` |
| `src/convert.ts` | Reads the PDF with unpdf, page ranges (`parsePageRange`), calls `pagesToMarkdown` |
| `src/cache.ts` | `~/.docdiet/cache` (or `$DOCDIET_HOME`), key = realpath + size + mtime + pages + `CONVERTER_VERSION`; writes `.md`, `.json` meta and a `.pdf` symlink to the original |
| `src/hook.ts` | `handleHookInput` (pure-ish, testable) + `runHook` (stdin/stdout); `planRead` windows Markdown too big for one Read |
| `src/prompt.ts` | `UserPromptSubmit`: Markdown (inline if short, else its path) for `@`-attached PDFs |
| `src/install.ts` | Adds/removes our hook in Claude settings without touching others |
| `src/stats.ts` | Token estimates per Claude Code read mode (`document` / `images`, see `docs/claude-code-internals.md`) and `stats.jsonl` |
| `src/cli.ts` | `convert`, `install`, `uninstall`, `stats`, `hook` |

## Rules
- The hook must never block or break a Read: any error → exit 0 with no output (Claude reads the original).
- Paths inside the cache dir are never intercepted — that is how Claude can still open the original pages.
- Mostly scanned PDFs (≥ half the pages without text) pass through untouched.
- `updatedInput` replaces the whole tool input: send `file_path` plus `offset`/`limit` (they address Markdown lines). The hook always converts the whole PDF; `pages` becomes the line window of those pages.
- Read's `validateInput` runs on the original input *before* PreToolUse hooks; `@` attachments never reach Read hooks (covered by `UserPromptSubmit`). additionalContext over 10,000 chars is persisted to disk and only previewed.
- Bump `CONVERTER_VERSION` whenever Markdown output or cached metadata changes.
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
- Phase 2 in progress: MobileNetV3-small multi-label classifier (table / figure / two_columns; scans come from the
  text layer) trained in `ml/` on DocLayNet v1.2 + synthetic pages. Best checkpoint `ml/runs/model-varied2.pt`
  (real test: table 88%, figure 86%, two_columns 98% accuracy), exported with `ml/export.py` to
  `models/page-classifier.onnx` (preprocessing + sigmoid inside the graph; Node matches Python on 100% of labels).
  Routing: two-column pages get column-aware reading order (`findGutter` + `columnRows` in `markdown.ts`);
  tables and figures only get a note. Next: tables → table extraction, scans → OCR. Ask before downloading datasets.
