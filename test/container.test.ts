import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containerArgs, containerIsolation, type ContainerIdentity, type ContainerSettings } from '../src/container.js';
import type { Exec, ExecOptions, ExecResult } from '../src/exec.js';
import type { IsolatedExecOptions } from '../src/isolation.js';
import { sandboxEnv } from '../src/sandbox.js';

const settings: ContainerSettings = {
  engine: 'docker',
  image: 'evidence-gated-agent-runner',
  network: { agent: 'bridge', setup: 'bridge', gates: 'none' },
  memory: '4g',
  pids: 1024,
};
const user: ContainerIdentity = {
  uid: 1001,
  gid: 1001,
  passwdFile: '/tmp/id/passwd',
  groupFile: '/tmp/id/group',
  label: 'abc123',
};

const options = (overrides: Partial<IsolatedExecOptions> = {}): IsolatedExecOptions => ({
  cwd: '/work/ws',
  mounts: [
    { path: '/work/ws', writable: true },
    { path: '/work/runs/contract', writable: true },
    { path: '/work/runs/attachments', writable: false },
  ],
  network: 'agent',
  inheritEnv: false,
  env: {},
  ...overrides,
});

/** The value after a flag, for flags that appear once. */
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

describe('containerArgs', () => {
  it('runs as the host user, without capabilities, on a read-only root, with limits', () => {
    const { args } = containerArgs('ega-1', 'claude', ['-p'], options(), settings, user, {});
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-i']);
    expect(args).toContain('--init');
    expect(args).toContain('--read-only');
    expect(flag(args, '--name')).toBe('ega-1');
    expect(flag(args, '--pull')).toBe('never');
    expect(flag(args, '--entrypoint')).toBe('');
    expect(flag(args, '--user')).toBe('1001:1001');
    expect(flag(args, '--cap-drop')).toBe('ALL');
    expect(flag(args, '--security-opt')).toBe('no-new-privileges');
    expect(flag(args, '--tmpfs')).toBe('/tmp:rw,exec,nosuid,nodev');
    expect(flag(args, '--label')).toBe('evidence-gated-agent.workdir=abc123');
    expect(flag(args, '--memory')).toBe('4g');
    expect(flag(args, '--pids-limit')).toBe('1024');
    expect(flag(args, '--workdir')).toBe('/work/ws');
    expect(args.slice(-3)).toEqual(['evidence-gated-agent-runner', 'claude', '-p']);
    expect(args).not.toContain('--privileged');
  });

  it('mounts only what was declared, at the same paths, attachments read-only', () => {
    const { args } = containerArgs('ega-1', 'claude', [], options(), settings, user, {});
    const mounts = args.flatMap((arg, i) => (args[i - 1] === '--mount' ? [arg] : []));
    expect(mounts).toEqual([
      'type=bind,source=/work/ws,target=/work/ws',
      'type=bind,source=/work/runs/contract,target=/work/runs/contract',
      'type=bind,source=/work/runs/attachments,target=/work/runs/attachments,readonly',
      'type=bind,source=/tmp/id/passwd,target=/etc/passwd,readonly',
      'type=bind,source=/tmp/id/group,target=/etc/group,readonly',
    ]);
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--volume');
  });

  it('picks the network of the role, and none for git in the agent repository', () => {
    const net = (network: IsolatedExecOptions['network']) =>
      flag(containerArgs('n', 'x', [], options({ network }), settings, user, {}).args, '--network');
    expect([net('agent'), net('setup'), net('gates'), net('none')]).toEqual(['bridge', 'bridge', 'none', 'none']);
  });

  it('refuses paths that could inject mount options', () => {
    const evil = options({ mounts: [{ path: '/work/ws,target=/etc', writable: true }] });
    expect(() => containerArgs('n', 'x', [], evil, settings, user, {})).toThrow('cannot bind-mount path');
    expect(() => containerArgs('n', 'x', [], options({ cwd: 'relative' }), settings, user, {})).toThrow(
      'cannot bind-mount path',
    );
  });

  it('passes secrets by reference and drops host-only variables', () => {
    const env = sandboxEnv({
      remote: 'origin',
      passEnv: ['CLAUDE_CODE_OAUTH_TOKEN', 'GIT_TOKEN'],
      home: '/work/ws.home',
      source: {
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
        TMPDIR: '/tmp/me',
        LANG: 'pt_BR.UTF-8',
        HTTPS_PROXY: 'http://user:pass@proxy:3128',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret',
        GIT_TOKEN: 'ghp_secret',
        AWS_SECRET_ACCESS_KEY: 'not-allowlisted',
      },
    });
    const { args, env: cliEnv } = containerArgs('n', 'claude', [], options({ env }), settings, user, {
      PATH: '/host/bin',
      HOME: '/home/me',
      DOCKER_HOST: 'unix:///run/docker.sock',
    });
    const variables = args.flatMap((arg, i) => (args[i - 1] === '-e' ? [arg] : []));

    expect(variables).toContain('HOME=/work/ws.home');
    expect(variables).toContain('LANG=pt_BR.UTF-8');
    expect(variables).toContain('GIT_CONFIG_KEY_0=protocol.allow');
    // By reference: the value never appears in the docker command line.
    expect(variables).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(variables).toContain('HTTPS_PROXY');
    expect(variables).toContain('GIT_TOKEN');
    expect(args.join(' ')).not.toContain('sk-ant-oat-secret');
    expect(args.join(' ')).not.toContain('ghp_secret');
    expect(args.join(' ')).not.toContain('user:pass');
    expect(variables.some((v) => /^(PATH|SHELL|TMPDIR)\b/.test(v))).toBe(false);
    expect(args.join(' ')).not.toContain('AWS_SECRET_ACCESS_KEY');

    // The docker CLI gets what it needs to reach the daemon, plus the referenced values.
    expect(cliEnv).toEqual({
      PATH: '/host/bin',
      HOME: '/home/me',
      DOCKER_HOST: 'unix:///run/docker.sock',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret',
      GIT_TOKEN: 'ghp_secret',
      HTTPS_PROXY: 'http://user:pass@proxy:3128',
    });
  });

  it('refuses to override the docker client variables through the container environment', () => {
    expect(() =>
      containerArgs('n', 'x', [], options({ env: { DOCKER_HOST: 'tcp://evil:2375' } }), settings, user, {}),
    ).toThrow('cannot pass DOCKER_HOST');
  });

  it('refuses an image that docker would read as an option', () => {
    expect(() => containerArgs('n', 'x', [], options(), { ...settings, image: '--privileged' }, user, {})).toThrow(
      'not a docker image reference',
    );
  });
});

describe('containerIsolation', () => {
  const done: ExecResult = { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };

  function fakeDocker(run: Partial<ExecResult>) {
    const calls: string[][] = [];
    const exec: Exec = async (_command, args, _options: ExecOptions) => {
      calls.push([...args]);
      if (args[0] === 'ps') return { ...done, stdout: 'stale1\nstale2\n' };
      if (args[0] === 'run') return { ...done, ...run };
      return done;
    };
    return { exec, calls };
  }

  it('prepares once per poll: checks the image, writes the identity, removes leftovers of a killed poll', async () => {
    const identityDir = join(await mkdtemp(join(tmpdir(), 'ega-id-')), 'container');
    const docker = fakeDocker({});
    const isolation = containerIsolation(docker.exec, settings, { uid: 1001, gid: 1001, identityDir, label: 'abc123' });
    await isolation.exec('git', ['status'], options({ network: 'none' }));
    await isolation.exec('git', ['status'], options({ network: 'none' }));

    expect(docker.calls.map((args) => args[0])).toEqual(['image', 'ps', 'rm', 'run', 'run']);
    expect(docker.calls[1]).toEqual(['ps', '-aq', '--filter', 'label=evidence-gated-agent.workdir=abc123']);
    expect(docker.calls[2]).toEqual(['rm', '-f', 'stale1', 'stale2']);
    expect(await readFile(join(identityDir, 'passwd'), 'utf8')).toContain('ega:x:1001:1001:');
  });

  it('removes the container explicitly only when the CLI may have left it running', async () => {
    const identityDir = join(await mkdtemp(join(tmpdir(), 'ega-id-')), 'container');
    const host = { uid: 1001, gid: 1001, identityDir, label: 'abc123' };
    const normal = fakeDocker({ code: 1 });
    await containerIsolation(normal.exec, settings, host).exec('npm', ['test'], options());
    expect(normal.calls.filter((args) => args[0] === 'rm' && args[2]?.startsWith('ega-'))).toEqual([]);

    const timedOut = fakeDocker({ code: 143, timedOut: true });
    await containerIsolation(timedOut.exec, settings, host).exec('npm', ['test'], options());
    const name = flag(timedOut.calls.find((args) => args[0] === 'run') as string[], '--name');
    expect(timedOut.calls.at(-1)).toEqual(['rm', '-f', name]);
  });
});
