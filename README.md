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

Token figures are **estimates** (~4 characters per token, ~1,600 tokens per page image).

## How it works

`docdiet install` adds a Claude Code `PreToolUse` hook on the `Read` tool:

1. Claude asks to read `something.pdf`.
2. The hook converts it (or reuses the cache: `~/.docdiet/cache`, keyed by path, size and modification time) and
   points the Read at the `.md` file instead. A `pages` range (e.g. `"1-5"`) converts only those pages.
3. The Markdown starts with a comment saying where it came from and how to see the original pages,
   in case Claude needs a figure.

It steps aside — Claude reads the PDF as usual — when:
- half or more of the pages have no text layer (scans): Markdown would lose most of the content;
- the file is broken, missing, or anything goes wrong. A failed conversion never blocks a read.

Not intercepted: files attached with `@` in a prompt (Claude Code reads those without the Read tool).

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

## Limitations (phase 1)

- Scanned pages are skipped, not OCR'd.
- Tables come out as plain lines, two-column layouts may interleave, figures are dropped.
- Headings are detected by font size only (bold body-size headings are not).

These are what phase 2 is for: a small neural network that classifies each page (text / table / figure / scan)
so each kind gets the right treatment.
