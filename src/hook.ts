import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { getOrConvert, isInCache } from './cache.js';
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
  limit?: number;
  context?: string;
}

// A Markdown that does not fit in one Read gets an explicit first window plus a page index,
// so Claude can jump with offset/limit instead of hitting Read's size error or truncation.
export function planRead(markdown: string, markdownPath: string, maxTokens = readMaxTokens()): ReadPlan {
  const budget = Math.floor(maxTokens * SAFE_CHARS_PER_TOKEN * 0.8);
  if (Buffer.byteLength(markdown) <= READ_MAX_BYTES && markdown.length <= budget) return {};

  const lines = markdown.split('\n');
  let limit = 0;
  for (let chars = 0; limit < lines.length && chars + lines[limit].length + 1 <= budget; limit++) {
    chars += lines[limit].length + 1;
  }
  limit = Math.max(1, limit);

  const pageStarts = lines.flatMap((line, i) => {
    const match = /^<!-- page (\d+) -->$/.exec(line);
    return match ? [{ page: Number(match[1]), line: i + 1 }] : [];
  });
  const step = Math.ceil(pageStarts.length / MAX_INDEX_ENTRIES);
  const index = pageStarts.filter((_, i) => i % step === 0).map((p) => `p${p.page}:${p.line}`);
  const lastShown = pageStarts.filter((p) => p.line <= limit).at(-1)?.page;

  const context =
    `docdiet: the Markdown (${markdownPath}, ${lines.length} lines, ~${estimateTokens(markdown)} tokens) is too large ` +
    `for one Read, so this Read returns only lines 1-${limit}${lastShown ? ` (through page ${lastShown})` : ''}. ` +
    `Read it with offset/limit for the rest, or Grep it.` +
    (index.length ? ` Page start lines (page:line): ${index.join(' ')}` : '');
  return { limit, context };
}

// Returns null to let Claude read the file untouched. Any failure must fall through:
// a broken conversion should never stop Claude from reading a document.
export async function handleHookInput(input: HookInput): Promise<HookOutput | null> {
  const filePath = input.tool_input?.file_path;
  if (input.tool_name !== 'Read' || !filePath || !/\.pdf$/i.test(filePath)) return null;
  const path = isAbsolute(filePath) ? filePath : resolve(input.cwd ?? process.cwd(), filePath);
  if (isInCache(path) || !existsSync(path)) return null;

  try {
    const { markdownPath, conversion, cached } = await getOrConvert(path, input.tool_input?.pages);
    const pages = conversion.convertedPages.length;
    // Mostly scanned: Markdown would lose most of the content, the original is better.
    if (pages === 0 || conversion.textlessPages.length * 2 >= pages) return null;

    const { offset, limit, pages: pageSpec } = input.tool_input ?? {};
    const readMode = pdfReadMode(pageSpec, conversion.totalPages);
    const pdfTokens = estimatePdfTokens(conversion, readMode);
    const markdownTokens = estimateTokens(conversion.markdown);
    await recordStat({
      ts: new Date().toISOString(),
      file: path,
      pages,
      pdfTokens,
      markdownTokens,
      cached,
      readMode,
    }).catch(() => {});

    // offset/limit now address Markdown lines: Claude uses them to page through a long conversion.
    const plan = offset === undefined && limit === undefined ? planRead(conversion.markdown, markdownPath) : {};
    const updatedInput: ReadInput = { file_path: markdownPath };
    if (offset !== undefined) updatedInput.offset = offset;
    const windowLimit = limit ?? plan.limit;
    if (windowLimit !== undefined) updatedInput.limit = windowLimit;
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
    const output = await handleHookInput(JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // fall through: exit 0 with no output leaves the Read untouched
  }
}
