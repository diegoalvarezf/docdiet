import { describe, expect, it } from 'vitest';
import { hookCommand, withHook, withoutHook } from '../src/install.js';

const command = hookCommand('/usr/local/bin/node', '/opt/docdiet/dist/cli.js');

describe('settings editing', () => {
  it('adds a Read PreToolUse hook and keeps everything else', () => {
    const settings = withHook({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }, command);
    expect(settings.model).toBe('opus');
    expect(settings.hooks?.Stop).toHaveLength(1);
    expect(settings.hooks?.PreToolUse).toEqual([{ matcher: 'Read', hooks: [{ type: 'command', command, timeout: 120 }] }]);
  });

  it('is idempotent and replaces an older docdiet command', () => {
    const once = withHook({}, hookCommand('/old/node', '/old/docdiet/cli.js'));
    const twice = withHook(once, command);
    expect(twice.hooks?.PreToolUse).toHaveLength(1);
    expect(twice.hooks?.PreToolUse?.[0].hooks?.[0].command).toBe(command);
  });

  it('removes only its own hook', () => {
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] };
    const settings = withHook({ hooks: { PreToolUse: [other] } }, command);
    expect(withoutHook(settings).hooks?.PreToolUse).toEqual([other]);
    expect(withoutHook(withHook({}, command))).toEqual({});
  });
});
