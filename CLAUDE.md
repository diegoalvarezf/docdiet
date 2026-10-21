# docdiet — Claude Code Instructions

## Project overview
Claude Code `PreToolUse` hook on `Read`: converts PDFs to compact Markdown (cached) so agents spend fewer tokens.
100% local. Also the owner's neural-network learning project (phase 2) — explain NN steps as we go.

**Stack:** TypeScript, Node.js 22+, single package, pnpm. PDF text via `unpdf` (pdf.js). Tests: vitest, fixtures built with `pdf-lib`.

## Files

| File | Responsibility |
|------|---------------|
| `src/markdown.ts` | Pure: positioned text items → Markdown (lines, headings by font size, paragraphs, lists, de-hyphenation, running header/footer + page number removal, textless pages, column order on pages labelled two-column, `_`/`^` script markers, stacked formulas as laid-out code blocks) |
| `src/classify.ts` | Page classifier: renders pages to 224×320 gray (pdf.js + `@napi-rs/canvas`), runs `models/page-classifier.onnx` |
| `src/tables.ts` | Pure: rebuilds Markdown tables from text positions (cells by wide gaps, columns from the fullest rows, wrapped cells joined) on pages labelled table |
| `src/ocr.ts` | Optional OCR of textless pages with the system `tesseract` (TSV words → positioned items, confidence ≥ 70%, parallel, time budget in hooks) |
| `src/visual.ts` | Ink outside text boxes on a 200 px render + embedded images from the operator list: visual pages (≥ 2% ink, < 40 words) and figures (non-repeated images ≥ 2% of the page, or ≥ 3% ink after removing the page template) |
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
- Mostly image PDFs (≥ half the pages without text after OCR, or mostly an image per `visual.ts`) pass through untouched.
- Repeated top/bottom lines are dropped only if identical on every page or their number follows the page, and never if they are headings (keeps "Ejercicio N", "Chapter N").
- Reads of ≤ 3 given pages pass through: they usually want a figure or a formula and save little.
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
  table pages get Markdown tables rebuilt from text positions (`tables.ts`); figures only get a note;
  textless pages get Tesseract OCR (`ocr.ts`, 97% word match on rasterized DocLayNet pages with the right
  languages). Ask before downloading datasets.
