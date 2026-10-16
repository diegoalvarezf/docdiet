import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { getOrConvert, isInCache } from './cache.js';
import { parsePageRange } from './convert.js';
import { HOOK_OCR_BUDGET_MS } from './ocr.js';
import { handlePromptSubmit, type PromptInput } from './prompt.js';
import { estimatePdfTokens, estimateTokens, pdfReadMode, recordStat } from './stats.js';

export interface HookInput {
  tool_name?: string;
  tool_input?: { file_path?: string; pages?: string; offset?: number; limit?: number };
  cwd?: string;
}

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow';
    permissionDecisionReason: string;
    updatedInput: ReadInput;
    additionalContext?: string;
  };
}

// Claude Code's Read limits (2.1.201): a whole-file read over 256 KB fails, and content over
// 25,000 tokens (CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS) is cut or fails when a limit is set.
const READ_MAX_BYTES = 256 * 1024;
const DEFAULT_READ_MAX_TOKENS = 25_000;
// Read counts real tokens; ~3 chars per token stays on the safe side for non-English text.
const SAFE_CHARS_PER_TOKEN = 3;
const MAX_INDEX_ENTRIES = 200;

function readMaxTokens(): number {
  const value = Number.parseInt(process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS ?? '', 10);
  return value > 0 ? value : DEFAULT_READ_MAX_TOKENS;
}

export interface ReadPlan {
  offset?: number;
  limit?: number;
  context?: string;
}

// Maps a Read onto the Markdown of the whole PDF. A `pages` request becomes the line window of
// those pages, and anything that does not fit in one Read gets a first window that does. When
// there is more than Claude asked for or got, the context says where it is and how to reach it.
// Returns null when the requested pages are not in the Markdown.
export function planRead(
  markdown: string,
  markdownPath: string,
  pages?: number[],
  maxTokens = readMaxTokens(),
): ReadPlan | null {
  const lines = markdown.split('\n');
  const pageStarts = lines.flatMap((line, i) => {
    const match = /^<!-- page (\d+) -->$/.exec(line);
    return match ? [{ page: Number(match[1]), line: i + 1 }] : [];
  });

  let first = 1;
  let last = lines.length;
  if (pages?.length) {
    const start = pageStarts.find((p) => p.page === pages[0]);
    if (!start) return null;
    first = start.line;
    const next = pageStarts.find((p) => p.page > pages[pages.length - 1]);
    last = next ? next.line - 1 : lines.length;
  }

  const budget = Math.floor(maxTokens * SAFE_CHARS_PER_TOKEN * 0.8);
  let limit = 0;
  for (let chars = 0; first + limit <= last; limit++) {
    chars += lines[first + limit - 1].length + 1;
    if (chars > budget) break;
  }
  limit = Math.max(1, limit);
  const truncated = first + limit - 1 < last;
  const tooBigForWholeRead = Buffer.byteLength(markdown) > READ_MAX_BYTES;
  if (!pages?.length && !truncated && !tooBigForWholeRead) return {};

  const totalPages = pageStarts.at(-1)?.page;
  const about = `${markdownPath}, the Markdown of the whole PDF (${totalPages ?? '?'} pages, ${lines.length} lines, ~${estimateTokens(markdown)} tokens)`;
  const lastShown = pageStarts.filter((p) => p.line <= first + limit - 1).at(-1)?.page;
  const shown = `lines ${first}-${first + limit - 1}${lastShown ? ` (through page ${lastShown})` : ''}`;
  const parts = pages?.length
    ? [
        `docdiet: pages ${pages[0]}-${pages[pages.length - 1]} are lines ${first}-${last} of ${about}.`,
        truncated ? `They do not fit in one Read, so this Read returns only ${shown}.` : '',
        'For more, Read that file with offset/limit instead of requesting PDF page ranges, or Grep it.',
      ]
    : [`docdiet: ${about} is too large for one Read, so this Read returns only ${shown}.`, 'Read it with offset/limit for the rest, or Grep it.'];
  if (truncated || tooBigForWholeRead) {
    const step = Math.ceil(pageStarts.length / MAX_INDEX_ENTRIES);
    const index = pageStarts.filter((_, i) => i % step === 0).map((p) => `p${p.page}:${p.line}`);
    if (index.length) parts.push(`Page start lines (page:line): ${index.join(' ')}`);
  }
  return { offset: first > 1 ? first : undefined, limit, context: parts.filter(Boolean).join(' ') };
}

// Returns null to let Claude read the file untouched. Any failure must fall through:
// a broken conversion should never stop Claude from reading a document.
export async function handleHookInput(input: HookInput): Promise<HookOutput | null> {
  const filePath = input.tool_input?.file_path;
  if (input.tool_name !== 'Read' || !filePath || !/\.pdf$/i.test(filePath)) return null;
  const path = isAbsolute(filePath) ? filePath : resolve(input.cwd ?? process.cwd(), filePath);
  if (isInCache(path) || !existsSync(path)) return null;

  try {
    // Always the whole PDF: one cache entry serves every page range, and Claude can be told
    // the rest of the document is already there instead of asking for it 20 pages at a time.
    const { markdownPath, conversion, cached } = await getOrConvert(path, undefined, { ocrBudgetMs: HOOK_OCR_BUDGET_MS });
    const { offset, limit, pages: pageSpec } = input.tool_input ?? {};
    const requested = parsePageRange(pageSpec, conversion.totalPages);
    const textless = requested.filter((p) => conversion.textlessPages.includes(p));
    // Mostly scanned: Markdown would lose most of the content, the original is better.
    if (requested.length === 0 || textless.length * 2 >= requested.length) return null;

    // offset/limit address Markdown lines: Claude uses them to page through a long conversion.
    const explicit = offset !== undefined || limit !== undefined;
    const plan = explicit ? {} : planRead(conversion.markdown, markdownPath, pageSpec ? requested : undefined);
    if (!plan) return null;
    const updatedInput: ReadInput = { file_path: markdownPath };
    const windowOffset = offset ?? plan.offset;
    const windowLimit = limit ?? plan.limit;
    if (windowOffset !== undefined) updatedInput.offset = windowOffset;
    if (windowLimit !== undefined) updatedInput.limit = windowLimit;

    const readMode = pdfReadMode(pageSpec, conversion.totalPages);
    const pdfTokens = estimatePdfTokens(
      { rawTextChars: conversion.rawTextChars, pageSizes: requested.map((p) => conversion.pageSizes[p - 1]) },
      readMode,
    );
    const servedLines = conversion.markdown.split('\n').slice((windowOffset ?? 1) - 1);
    const served = windowLimit === undefined ? servedLines : servedLines.slice(0, windowLimit);
    const markdownTokens = estimateTokens(served.join('\n'));
    await recordStat({
      ts: new Date().toISOString(),
      file: path,
      pages: requested.length,
      pdfTokens,
      markdownTokens,
      cached,
      readMode,
    }).catch(() => {});

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `docdiet: PDF converted to Markdown (~${markdownTokens} tokens instead of ~${pdfTokens})`,
        updatedInput,
        ...(plan.context && { additionalContext: plan.context }),
      },
    };
  } catch {
    return null;
  }
}

export async function runHook(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput & PromptInput;
    const output = input.hook_event_name === 'UserPromptSubmit' ? await handlePromptSubmit(input) : await handleHookInput(input);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // fall through: exit 0 with no output leaves the Read untouched
  }
}
