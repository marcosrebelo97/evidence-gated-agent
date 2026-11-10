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

  it('passes proxy and CA settings, so the agent works behind a corporate proxy', () => {
    const proxied = { ...source, HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem' };
    expect(sandboxEnv({ remote: 'origin', source: proxied })).toMatchObject({
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
    });
  });

  it('replaces HOME when given one, and never passes config dirs that point back to the user', () => {
    const user = { ...source, XDG_CONFIG_HOME: '/home/agent/.config', CLAUDE_CONFIG_DIR: '/home/agent/.claude' };
    const env = sandboxEnv({ remote: 'origin', home: '/work/REQ-1.home', source: user });
    expect(env.HOME).toBe('/work/REQ-1.home');
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(sandboxEnv({ remote: 'origin', source }).HOME).toBe('/home/agent');
  });

  it('keeps git transports for trusted setup, but still disables the push URL', () => {
    const env = sandboxEnv({ remote: 'origin', allowGitTransport: true, source });
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.pushurl' });
    expect(Object.values(env)).not.toContain('protocol.allow');
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
