import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from './exec.js';
import type { Isolation, IsolatedExecOptions, NetworkRole } from './isolation.js';

export interface ContainerSettings {
  engine: 'docker';
  image: string;
  /** Docker network per role; `none` for git inside the agent's repository is fixed. */
  network: Record<Exclude<NetworkRole, 'none'>, string>;
  memory: string;
  pids: number;
}

/**
 * The host user, and passwd/group files that name it. Without an entry for its uid, Node's
 * os.userInfo() throws inside the container, and tools that ask for the user name fail.
 */
export interface ContainerUser {
  uid: number;
  gid: number;
  passwdFile: string;
  groupFile: string;
}

/** Writes minimal passwd/group files for `uid:gid`, mounted read-only over the image's. */
export async function createContainerUser(uid: number, gid: number): Promise<ContainerUser> {
  if (uid === 0) throw new Error('isolation "container" refuses to run as root: run the orchestrator as a regular user');
  const dir = await mkdtemp(join(tmpdir(), 'ega-identity-'));
  const passwdFile = join(dir, 'passwd');
  const groupFile = join(dir, 'group');
  await writeFile(
    passwdFile,
    `root:x:0:0:root:/root:/usr/sbin/nologin\nega:x:${uid}:${gid}:evidence-gated-agent:/tmp:/usr/sbin/nologin\n`,
    { mode: 0o644 },
  );
  await writeFile(groupFile, `root:x:0:\nega:x:${gid}:\n`, { mode: 0o644 });
  return { uid, gid, passwdFile, groupFile };
}

/**
 * Safe to put on the command line (`-e NAME=value`). Every other variable (tokens,
 * proxies that may carry credentials) goes by reference (`-e NAME`): docker reads its
 * value from its own environment, and it never shows up in `ps`.
 */
function isPlainVariable(name: string): boolean {
  return /^(GIT_[A-Z0-9_]+|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TZ)$/.test(name);
}

/**
 * Host-specific: inside the image, PATH and the shell are the image's, /tmp is its own
 * tmpfs, and a host CA path would not exist. A corporate CA belongs in the image.
 */
const HOST_ONLY_VARIABLES = new Set(['PATH', 'SHELL', 'TMPDIR', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']);

/** What the docker CLI itself needs from the orchestrator's environment to reach the daemon. */
const DOCKER_CLIENT_VARIABLES = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];

/** `--mount` is comma-separated: a path with a comma (or a newline) could add mount options. */
function assertMountable(path: string): void {
  if (!path.startsWith('/') || /[,\n\r]/.test(path)) throw new Error(`cannot bind-mount path: ${JSON.stringify(path)}`);
}

export interface ContainerInvocation {
  /** Arguments for the docker CLI. */
  args: string[];
  /** Environment of the docker CLI: what it needs, plus the values of the by-reference variables. */
  env: Record<string, string>;
}

/**
 * Pure: how one isolated command becomes a `docker run`. The container sees only the declared
 * mounts, at the same paths as on the host, runs as the host user without capabilities or
 * privilege escalation, with a read-only root and limits on memory and processes.
 */
export function containerArgs(
  name: string,
  command: string,
  args: readonly string[],
  options: IsolatedExecOptions,
  settings: ContainerSettings,
  user: ContainerUser,
  hostEnv: NodeJS.ProcessEnv = process.env,
): ContainerInvocation {
  const network = options.network === 'none' ? 'none' : settings.network[options.network];
  const dockerArgs = [
    'run', '--rm', '-i', '--init',
    '--name', name,
    '--pull', 'never',
    // The command runs as given: no entrypoint of the image rewrites it.
    '--entrypoint', '',
    '--user', `${user.uid}:${user.gid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev',
    '--memory', settings.memory,
    '--pids-limit', String(settings.pids),
    '--network', network,
    '--workdir', options.cwd,
  ];

  assertMountable(options.cwd);
  for (const mount of options.mounts) {
    assertMountable(mount.path);
    dockerArgs.push('--mount', `type=bind,source=${mount.path},target=${mount.path}${mount.writable ? '' : ',readonly'}`);
  }

  for (const [file, target] of [[user.passwdFile, '/etc/passwd'], [user.groupFile, '/etc/group']] as const) {
    assertMountable(file);
    dockerArgs.push('--mount', `type=bind,source=${file},target=${target},readonly`);
  }

  const env: Record<string, string> = {};
  for (const variable of DOCKER_CLIENT_VARIABLES) {
    const value = hostEnv[variable];
    if (value !== undefined) env[variable] = value;
  }
  for (const [variable, value] of Object.entries(options.env ?? {})) {
    if (HOST_ONLY_VARIABLES.has(variable)) continue;
    if (isPlainVariable(variable)) {
      dockerArgs.push('-e', `${variable}=${value}`);
    } else {
      if (DOCKER_CLIENT_VARIABLES.includes(variable)) throw new Error(`cannot pass ${variable} into the container`);
      dockerArgs.push('-e', variable);
      env[variable] = value;
    }
  }

  dockerArgs.push(settings.image, command, ...args);
  return { args: dockerArgs, env };
}

/** Containers started and not yet removed: the CLI removes them if the orchestrator is stopped. */
const running = new Set<string>();

/**
 * Removes every container still running. Synchronous, for signal handlers: killing the docker
 * CLI does not stop the container it started.
 */
export function removeActiveContainers(): number {
  const names = [...running];
  if (names.length > 0) {
    try {
      execFileSync('docker', ['rm', '-f', ...names], { stdio: 'ignore', timeout: 30_000 });
    } catch {
      // best effort: the orchestrator is exiting
    }
  }
  running.clear();
  return names.length;
}

export function containerIsolation(exec: Exec, settings: ContainerSettings, user: ContainerUser): Isolation {
  return {
    mode: 'container',
    async exec(command, args, options) {
      const name = `ega-${randomBytes(6).toString('hex')}`;
      const invocation = containerArgs(name, command, args, options, settings, user);
      running.add(name);
      try {
        return await exec(settings.engine, invocation.args, {
          cwd: options.cwd,
          env: invocation.env,
          inheritEnv: false,
          ...(options.input !== undefined ? { input: options.input } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          killGroupOnExit: true,
        });
      } finally {
        // On a timeout the CLI is killed, not the container: remove it either way.
        await exec(settings.engine, ['rm', '-f', name], { cwd: options.cwd, env: invocation.env, inheritEnv: false, timeoutMs: 60_000 });
        running.delete(name);
      }
    },
  };
}

/** Fails early, with a hint, when the image was not built: `--pull never` would only say "No such image". */
export async function assertImageExists(exec: Exec, settings: ContainerSettings): Promise<void> {
  const result = await exec(settings.engine, ['image', 'inspect', '--format', '{{.Id}}', settings.image], {
    cwd: '/',
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `container image "${settings.image}" not found (${result.stderr.trim().split('\n')[0] ?? ''}); ` +
        `build it with: docker build -f docker/runner.Dockerfile -t ${settings.image} docker/`,
    );
  }
}
