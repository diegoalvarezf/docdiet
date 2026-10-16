import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { getOrConvert, isInCache } from './cache.js';
import { estimateTokens } from './stats.js';

export interface PromptInput {
  hook_event_name?: string;
  prompt?: string;
  cwd?: string;
}

export interface PromptOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

// Claude Code persists additionalContext over 10,000 chars to disk and shows only a preview,
// so inline Markdown only while the whole context stays under that.
const MAX_INLINE_CHARS = 9_000;

// Same rules as Claude Code's @-mention parser: @"quoted path" or @path, at the start or after
// whitespace / CJK punctuation, with an optional #L10-20 line suffix.
export function pdfMentions(prompt: string): string[] {
  const boundary = '(?:^|[\\s\\u3002\\u3001\\uFF1F\\uFF01])';
  const quoted = new RegExp(`${boundary}@"([^"]+)"`, 'g');
  const plain = new RegExp(`${boundary}@([^\\s"]+)\\b`, 'g');
  const mentions = [...prompt.matchAll(quoted), ...prompt.matchAll(plain)].map((m) => m[1].replace(/#.*$/, ''));
  return [...new Set(mentions)].filter((m) => /\.pdf$/i.test(m));
}

function resolveMention(mention: string, cwd: string): string {
  if (mention === '~' || mention.startsWith('~/')) return join(homedir(), mention.slice(1));
  return isAbsolute(mention) ? mention : resolve(cwd, mention);
}

// Claude Code attaches an @-mentioned PDF without its content (a "PDF file read" note, or a hint to
// read it by pages): point Claude at the Markdown, inline when it is short.
export async function handlePromptSubmit(input: PromptInput): Promise<PromptOutput | null> {
  const cwd = input.cwd ?? process.cwd();
  const notes: { pointer: string; inline?: string }[] = [];

  for (const mention of pdfMentions(input.prompt ?? '')) {
    const path = resolveMention(mention, cwd);
    if (isInCache(path) || !existsSync(path)) continue;
    try {
      const { markdownPath, originalLink, conversion } = await getOrConvert(path);
      const { totalPages, textlessPages, markdown } = conversion;
      if (textlessPages.length * 2 >= totalPages) {
        notes.push({ pointer: `@${mention} is mostly scanned pages: Read ${originalLink} with pages to see them.` });
        continue;
      }
      const size = `${totalPages} pages, ${markdown.split('\n').length} lines, ~${estimateTokens(markdown)} tokens`;
      const intro = `@${mention} was attached without its content. docdiet's Markdown of it (${size})`;
      notes.push({
        pointer: `${intro} is at ${markdownPath}; Read that file (with offset/limit if large) instead of the PDF.`,
        inline: `${intro}, also at ${markdownPath}:\n\n${markdown}`,
      });
    } catch {
      // unconvertible: Claude Code's own attachment handling stays as is
    }
  }
  if (notes.length === 0) return null;

  const header = 'docdiet:';
  const plain = [header, ...notes.map((n) => n.pointer)].join('\n');
  const inlined = [header, ...notes.map((n) => n.inline ?? n.pointer)].join('\n\n');
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: inlined.length <= MAX_INLINE_CHARS ? inlined : plain,
    },
  };
}
