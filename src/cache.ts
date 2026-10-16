import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, sep } from 'node:path';
import { convertPdf, type Conversion } from './convert.js';

// Bump when the Markdown output or the cached metadata changes, so old cache entries are not reused.
export const CONVERTER_VERSION = 3;

export function docdietHome(): string {
  return process.env.DOCDIET_HOME ?? join(homedir(), '.docdiet');
}

export function cacheDir(): string {
  return join(docdietHome(), 'cache');
}

export function isInCache(path: string): boolean {
  return path.startsWith(cacheDir() + sep);
}

export interface CachedConversion {
  markdownPath: string;
  originalLink: string;
  conversion: Conversion;
  cached: boolean;
}

interface Meta extends Omit<Conversion, 'markdown'> {
  source: string;
}

export async function getOrConvert(path: string, pageSpec?: string): Promise<CachedConversion> {
  const source = await realpath(path);
  const info = await stat(source);
  const key = createHash('sha256')
    .update(JSON.stringify([CONVERTER_VERSION, source, info.size, info.mtimeMs, pageSpec ?? '']))
    .digest('hex')
    .slice(0, 12);
  const name = basename(source, extname(source)).replace(/[^\w.-]+/g, '_').slice(0, 60);
  const dir = cacheDir();
  const markdownPath = join(dir, `${name}-${key}.md`);
  const metaPath = join(dir, `${name}-${key}.json`);
  // Paths inside the cache are never intercepted, so Claude can still open the original pages here.
  const originalLink = join(dir, `${name}-${key}.pdf`);

  if (existsSync(markdownPath) && existsSync(metaPath)) {
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Meta;
    const markdown = await readFile(markdownPath, 'utf8');
    return { markdownPath, originalLink, conversion: { ...meta, markdown }, cached: true };
  }

  const conversion = await convertPdf(source, pageSpec);
  await mkdir(dir, { recursive: true });
  await rm(originalLink, { force: true });
  await symlink(source, originalLink);
  // Long documents exceed Read's token cap and arrive truncated: say up front how to jump around.
  const lineCount = conversion.markdown.split('\n').length + 2;
  const header =
    `<!-- docdiet: Markdown of ${source} (pages ${describePages(conversion)} of ${conversion.totalPages}, ${lineCount} lines; ` +
    `each page starts with "<!-- page N -->", Grep for it to jump to a page). ` +
    `Images, figures and scanned pages are not included; to see the original pages, Read ${originalLink} -->\n\n`;
  const { markdown, ...rest } = conversion;
  await writeFile(markdownPath, header + markdown);
  await writeFile(metaPath, JSON.stringify({ ...rest, source } satisfies Meta));
  return { markdownPath, originalLink, conversion: { ...conversion, markdown: header + markdown }, cached: false };
}

function describePages({ convertedPages }: Conversion): string {
  if (convertedPages.length === 0) return 'none';
  const first = convertedPages[0];
  const last = convertedPages[convertedPages.length - 1];
  return last - first + 1 === convertedPages.length ? `${first}-${last}` : convertedPages.join(',');
}
