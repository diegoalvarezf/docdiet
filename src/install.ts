import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

interface HookHandler {
  type: string;
  command?: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, MatcherGroup[]> };

export function settingsPath(scope: 'user' | 'project', cwd = process.cwd()): string {
  return scope === 'user' ? join(homedir(), '.claude', 'settings.json') : join(cwd, '.claude', 'settings.local.json');
}

// process.execPath is the resolved binary (e.g. Homebrew's versioned Cellar path), which disappears on
// upgrade. Prefer the first `node` on PATH, which is usually a stable symlink.
export function stableNodePath(execPath = process.execPath, pathEnv = process.env.PATH ?? ''): string {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    if (existsSync(candidate)) return candidate;
  }
  return execPath;
}

export function hookCommand(nodePath: string, cliPath: string): string {
  return `${JSON.stringify(nodePath)} ${JSON.stringify(cliPath)} hook`;
}

function isOurs(handler: HookHandler): boolean {
  return handler.type === 'command' && /docdiet/.test(handler.command ?? '') && /\shook$/.test(handler.command ?? '');
}

export function withoutHook(settings: Settings): Settings {
  const groups = settings.hooks?.PreToolUse;
  if (!groups) return settings;
  const kept = groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
  const hooks = { ...settings.hooks };
  if (kept.length > 0) hooks.PreToolUse = kept;
  else delete hooks.PreToolUse;
  const next: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

export function withHook(settings: Settings, command: string): Settings {
  const clean = withoutHook(settings);
  const hooks = { ...clean.hooks };
  hooks.PreToolUse = [...(hooks.PreToolUse ?? []), { matcher: 'Read', hooks: [{ type: 'command', command, timeout: 120 }] }];
  return { ...clean, hooks };
}

async function readSettings(path: string): Promise<Settings> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, 'utf8');
  return text.trim() ? (JSON.parse(text) as Settings) : {};
}

export async function install(path: string, command: string): Promise<void> {
  const settings = withHook(await readSettings(path), command);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + '\n');
}

export async function uninstall(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const before = await readSettings(path);
  const after = withoutHook(before);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  await writeFile(path, JSON.stringify(after, null, 2) + '\n');
  return true;
}
