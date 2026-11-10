import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exec } from '../src/exec.js';
import { sandboxEnv } from '../src/sandbox.js';
import { createGitFixture, git, GIT_IDENTITY, remoteBranches } from './helpers/git-fixture.js';

describe('sandboxEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/agent',
    LC_ALL: 'pt_BR.UTF-8',
    TELEGRAM_BOT_TOKEN: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    ANTHROPIC_API_KEY: 'needed',
  };

  it('keeps the baseline and explicit pass-throughs, drops everything else', () => {
    const env = sandboxEnv({ remote: 'origin', passEnv: ['ANTHROPIC_API_KEY'], source });
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/agent', LC_ALL: 'pt_BR.UTF-8', ANTHROPIC_API_KEY: 'needed' });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it('disables every git transport and the push URL of the remote', () => {
    const env = sandboxEnv({ remote: 'origin', source });
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'protocol.allow',
      GIT_CONFIG_VALUE_0: 'never',
      GIT_CONFIG_KEY_1: 'remote.origin.pushurl',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('with real git: local work still works, pushing does not', async () => {
    const fixture = await createGitFixture();
    const env = sandboxEnv({ remote: 'origin', extra: GIT_IDENTITY });
    await writeFile(join(fixture.clone, 'x.txt'), 'x');
    git(fixture.clone, 'add', 'x.txt');

    const commit = await exec('git', ['commit', '-q', '-m', 'x'], { cwd: fixture.clone, env, inheritEnv: false });
    expect(commit.code).toBe(0);

    for (const target of [['origin', 'HEAD:refs/heads/sneaky'], [fixture.remote, 'HEAD:refs/heads/sneaky-url']]) {
      const push = await exec('git', ['push', ...target], { cwd: fixture.clone, env, inheritEnv: false });
      expect(push.code).not.toBe(0);
    }
    expect(remoteBranches(fixture.remote)).toEqual(['main']);
  });
});
