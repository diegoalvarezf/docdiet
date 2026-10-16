# docdiet

> PDFs on a diet for AI coding agents.
> When Claude Code reads a PDF, docdiet hands it compact Markdown instead: fewer tokens, same content. 100% local.

## Why

Claude reads each PDF page as extracted text **plus an image of the page**. A text-heavy document costs
thousands of tokens per page, most of them for page images the agent rarely needs. Markdown keeps the words
and the structure (headings, paragraphs, lists) and drops the rest: running headers and footers, page numbers,
words hyphenated across lines.

```
$ docdiet convert report.pdf -o report.md
16 pages · ~19361 tokens instead of ~44582 (57% saved)
```

Token figures are **estimates**: ~4 characters per token, and page images priced the way Claude Code sends the PDF
(whole document, or 100 DPI JPEGs when read by page ranges). See `docs/claude-code-internals.md`.

## How it works

`docdiet install` adds a Claude Code `PreToolUse` hook on the `Read` tool:

1. Claude asks to read `something.pdf`.
2. The hook converts it (or reuses the cache: `~/.docdiet/cache`, keyed by path, size and modification time) and
   points the Read at the `.md` file instead. It always converts the whole PDF: a `pages` range (e.g. `"1-5"`)
   reads just those pages' lines, and Claude is told the rest of the document is already there.
   Markdown too large for one Read comes back in a first window with a page → line index.
3. The Markdown starts with a comment saying where it came from and how to see the original pages,
   in case Claude needs a figure.

It steps aside — Claude reads the PDF as usual — when:
- half or more of the pages have no text layer (scans): Markdown would lose most of the content;
- the file is broken, missing, or anything goes wrong. A failed conversion never blocks a read.

Files attached with `@` in a prompt never go through Read, and Claude Code sends no content for an
@-attached PDF. A `UserPromptSubmit` hook (also added by `docdiet install`) adds the Markdown to the prompt
when it is short, or its path otherwise.

## Usage

Requires Node.js 22+.

```bash
pnpm install && pnpm build
node dist/cli.js install            # hook in ~/.claude/settings.json (all projects)
node dist/cli.js install --project  # or only this project (.claude/settings.local.json)
```

| Command | What it does |
|---|---|
| `docdiet convert <file.pdf> [--pages 1-5] [-o out.md] [--no-cache]` | Print or write the Markdown |
| `docdiet install [--project]` / `uninstall [--project]` | Add / remove the Claude Code hook (never touches other hooks) |
| `docdiet stats` | Estimated tokens saved by the hook so far |
| `docdiet hook` | Used by Claude Code (reads the hook JSON on stdin) |

Restart open Claude Code sessions after installing.

## Page classifier

A small neural network (MobileNetV3-small fine-tuned on DocLayNet and synthetic pages, `ml/`) looks at each
page and says whether it has a table, a figure or two columns. It ships as `models/page-classifier.onnx` and
runs locally with `onnxruntime-node` (~20-30 ms per page, first conversion only). For now it adds notes to the
Markdown, so Claude knows when to check the original page. `DOCDIET_CLASSIFY=0` turns it off.

## Limitations

- Scanned pages are skipped, not OCR'd.
- Tables come out as plain lines, two-column layouts may interleave, figures are dropped (the classifier flags them).
- Headings are detected by font size only (bold body-size headings are not).

Next: use the classifier to route pages: tables → table extraction, two columns → column-aware reading order.
