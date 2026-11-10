import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
 * Who the containers run as, and what marks them. Without a passwd entry for its uid, Node's
 * os.userInfo() throws inside the container, so minimal passwd/group files that name it are
 * mounted read-only over the image's.
 */
export interface ContainerIdentity {
  uid: number;
  gid: number;
  passwdFile: string;
  groupFile: string;
  /** Value of the `evidence-gated-agent.workdir` label: finds containers a killed poll left behind. */
  label: string;
}

export const CONTAINER_LABEL = 'evidence-gated-agent.workdir';

/**
 * TMPDIR inside the container, on a tmpfs of its own. /tmp cannot be it: the mounts keep host
 * paths, and one under /tmp (say /tmp/claude-1001/...) makes docker create /tmp/claude-1001
 * owned by root, which Claude Code refuses as its temp directory.
 */
export const CONTAINER_TMPDIR = '/run/ega-tmp';

/** Docker image reference: never something docker would read as an option. */
export const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

/** Writes the passwd/group files into `dir` (under the workDir, replaced on every poll). */
export async function writeIdentityFiles(dir: string, uid: number, gid: number): Promise<{ passwdFile: string; groupFile: string }> {
  if (uid === 0) throw new Error('isolation "container" refuses to run as root: run the orchestrator as a regular user');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const passwdFile = join(dir, 'passwd');
  const groupFile = join(dir, 'group');
  const files: [string, string][] = [
    [passwdFile, `root:x:0:0:root:/root:/usr/sbin/nologin\nega:x:${uid}:${gid}:evidence-gated-agent:/tmp:/usr/sbin/nologin\n`],
    [groupFile, `root:x:0:\nega:x:${gid}:\n`],
  ];
  for (const [file, content] of files) {
    await rm(file, { force: true });
    await writeFile(file, content, { mode: 0o644, flag: 'wx' });
  }
  return { passwdFile, groupFile };
}

/**
 * Safe to put on the command line (`-e NAME=value`): only the names the orchestrator sets
 * itself, with values it chose. Every other variable (tokens, proxies that may carry
 * credentials, a GIT_TOKEN in passEnv) goes by reference (`-e NAME`): docker reads its value
 * from its own environment, and it never shows up in `ps`.
 */
function isPlainVariable(name: string): boolean {
  return /^(HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TZ|GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+|GLOBAL|NOSYSTEM)|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)|GIT_TERMINAL_PROMPT|GIT_NO_REPLACE_OBJECTS)$/.test(
    name,
  );
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
  user: ContainerIdentity,
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
    '--label', `${CONTAINER_LABEL}=${user.label}`,
    // exec: docker defaults a tmpfs to noexec, which breaks native builds and tools unpacked in /tmp.
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev',
    '--tmpfs', `${CONTAINER_TMPDIR}:rw,exec,nosuid,nodev,mode=1777`,
    '-e', `TMPDIR=${CONTAINER_TMPDIR}`,
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

  if (!IMAGE_REFERENCE.test(settings.image)) throw new Error(`not a docker image reference: ${JSON.stringify(settings.image)}`);
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

export interface ContainerHost {
  uid: number;
  gid: number;
  /** Where the identity files are written: a directory of the orchestrator's, under the workDir. */
  identityDir: string;
  label: string;
}

/**
 * Runs each command in a fresh container. The first command of a poll (always under the
 * poll lock) checks the image, writes the identity files and removes containers a killed
 * poll of the same workDir left behind.
 */
export function containerIsolation(exec: Exec, settings: ContainerSettings, host: ContainerHost): Isolation {
  let ready: Promise<ContainerIdentity> | undefined;
  const prepare = async (): Promise<ContainerIdentity> => {
    await assertImageExists(exec, settings);
    const files = await writeIdentityFiles(host.identityDir, host.uid, host.gid);
    await removeLabelledContainers(exec, settings, host.label);
    return { uid: host.uid, gid: host.gid, label: host.label, ...files };
  };

  return {
    mode: 'container',
    async exec(command, args, options) {
      ready ??= prepare().catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
      const identity = await ready;
      const name = `ega-${randomBytes(6).toString('hex')}`;
      const invocation = containerArgs(name, command, args, options, settings, identity);
      running.add(name);
      try {
        const result = await exec(settings.engine, invocation.args, {
          cwd: options.cwd,
          env: invocation.env,
          inheritEnv: false,
          ...(options.input !== undefined ? { input: options.input } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          killGroupOnExit: true,
        });
        // --rm removes a container that exited. On a timeout, or when docker itself failed (125+),
        // the CLI may be gone while the container still runs: remove it explicitly.
        if (result.timedOut || result.code >= 125) {
          await exec(settings.engine, ['rm', '-f', name], { cwd: options.cwd, env: invocation.env, inheritEnv: false, timeoutMs: 60_000 });
        }
        return result;
      } finally {
        running.delete(name);
      }
    },
  };
}

/** Removes containers with this workDir's label: what a poll killed with SIGKILL left running. */
async function removeLabelledContainers(exec: Exec, settings: ContainerSettings, label: string): Promise<void> {
  const listed = await exec(settings.engine, ['ps', '-aq', '--filter', `label=${CONTAINER_LABEL}=${label}`], {
    cwd: '/',
    timeoutMs: 30_000,
  });
  const ids = listed.stdout.split('\n').filter(Boolean);
  if (listed.code === 0 && ids.length > 0) {
    await exec(settings.engine, ['rm', '-f', ...ids], { cwd: '/', timeoutMs: 60_000 });
  }
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
