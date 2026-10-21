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

Token figures are **estimates**, calibrated against real Claude Code reads (Sonnet 5.5): ~3 characters per token,
page images priced the way Claude Code sends the PDF (whole document or 100 DPI JPEGs). Within ~15% of measured
values; see `docs/claude-code-internals.md`.

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
- Claude asks for 3 pages or fewer (`pages: "24"`): a targeted read is usually after a figure or a formula;
- half or more of the pages have no text layer even after OCR (see below), or are mostly an image with a few words
  (handwriting, diagrams, screenshots in slides): Markdown would lose most of the content;
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
runs locally with `onnxruntime-node` (~20-30 ms per page, first conversion only). Two-column pages are read
column by column, tables are rebuilt as Markdown tables from text positions, and figures get a note so Claude
knows when to check the original page.
`DOCDIET_CLASSIFY=0` turns it off.

## Scanned pages (OCR)

If [Tesseract](https://github.com/tesseract-ocr/tesseract) is installed (`brew install tesseract tesseract-lang`),
pages without a text layer are OCR'd at 300 DPI, in parallel, and go through the same pipeline (headings, columns,
tables). A page is used only when Tesseract's mean word confidence is at least 70%; the Markdown says which pages
came from OCR. Inside Claude Code hooks OCR stops after 60 s (about 100 pages); the rest stay as images.

- `DOCDIET_OCR_LANGS` picks the languages (Tesseract codes, default `eng+spa`; e.g. `eng+deu+fra`).
- `DOCDIET_OCR=0` turns OCR off. Without Tesseract, scans pass through to Claude as before.

## Limitations

- OCR quality depends on the scan and on `DOCDIET_OCR_LANGS` matching the document's language.
- Figures are dropped (the classifier flags them). Pages mixing one- and two-column sections may still interleave.
- Rebuilt tables can miss multi-level headers or sub-rows; tables the classifier misses stay plain lines.
- Headings are detected by font size only (bold body-size headings are not).

