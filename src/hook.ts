import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { getOrConvert, isInCache } from './cache.js';
import { estimatePdfTokens, estimateTokens, recordStat } from './stats.js';

export interface HookInput {
  tool_name?: string;
  tool_input?: { file_path?: string; pages?: string };
  cwd?: string;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow';
    permissionDecisionReason: string;
    updatedInput: { file_path: string };
  };
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

    const pdfTokens = estimatePdfTokens(conversion);
    const markdownTokens = estimateTokens(conversion.markdown);
    await recordStat({ ts: new Date().toISOString(), file: path, pages, pdfTokens, markdownTokens, cached }).catch(() => {});
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `docdiet: PDF converted to Markdown (~${markdownTokens} tokens instead of ~${pdfTokens})`,
        updatedInput: { file_path: markdownPath },
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
