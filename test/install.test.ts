import { describe, expect, it } from 'vitest';
import { hookCommand, withHook, withoutHook } from '../src/install.js';

const command = hookCommand('/usr/local/bin/node', '/opt/docdiet/dist/cli.js');

describe('settings editing', () => {
  it('adds the Read PreToolUse and UserPromptSubmit hooks and keeps everything else', () => {
    const settings = withHook({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }, command);
    expect(settings.model).toBe('opus');
    expect(settings.hooks?.Stop).toHaveLength(1);
    expect(settings.hooks?.PreToolUse).toEqual([{ matcher: 'Read', hooks: [{ type: 'command', command, timeout: 120 }] }]);
    expect(settings.hooks?.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command, timeout: 120 }] }]);
  });

  it('is idempotent and replaces an older docdiet command', () => {
    const once = withHook({}, hookCommand('/old/node', '/old/docdiet/cli.js'));
    const twice = withHook(once, command);
    expect(twice.hooks?.PreToolUse).toHaveLength(1);
    expect(twice.hooks?.PreToolUse?.[0].hooks?.[0].command).toBe(command);
    expect(twice.hooks?.UserPromptSubmit).toHaveLength(1);
  });

  it('removes only its own hook', () => {
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] };
    const settings = withHook({ hooks: { PreToolUse: [other] } }, command);
    expect(withoutHook(settings).hooks?.PreToolUse).toEqual([other]);
    expect(withoutHook(withHook({}, command))).toEqual({});
  });
});

describe('stableNodePath', () => {
  it('prefers the first node on PATH over the resolved binary', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { stableNodePath } = await import('../src/install.js');
    const bin = mkdtempSync(join(tmpdir(), 'docdiet-bin-'));
    writeFileSync(join(bin, 'node'), '');
    expect(stableNodePath('/opt/homebrew/Cellar/node/25.9.0/bin/node', `/nonexistent:${bin}`)).toBe(join(bin, 'node'));
    expect(stableNodePath('/fallback/node', '/nonexistent')).toBe('/fallback/node');
  });
});

describe('stableNodePath with Homebrew', () => {
  it('skips versioned Cellar dirs on PATH and maps the Cellar binary to <prefix>/bin/node', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { stableNodePath } = await import('../src/install.js');
    const prefix = mkdtempSync(join(tmpdir(), 'docdiet-brew-'));
    const cellarBin = join(prefix, 'Cellar', 'node', '25.9.0', 'bin');
    mkdirSync(cellarBin, { recursive: true });
    mkdirSync(join(prefix, 'bin'));
    writeFileSync(join(cellarBin, 'node'), '');
    writeFileSync(join(prefix, 'bin', 'node'), '');
    expect(stableNodePath(join(cellarBin, 'node'), cellarBin)).toBe(join(prefix, 'bin', 'node'));
  });
});
