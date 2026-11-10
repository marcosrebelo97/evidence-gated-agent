import { spawn, type ChildProcess } from 'node:child_process';

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** When false, the child sees only `env` (plus nothing from this process). Defaults to true. */
  inheritEnv?: boolean;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export type Exec = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;

const MAX_CAPTURE_CHARS = 2 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;
/** After the child exits, how long to wait for a grandchild that still holds stdout/stderr open. */
const STDIO_DRAIN_MS = 2_000;

const ownGroup = process.platform !== 'win32';
const active = new Set<ChildProcess>();

function appendCapped(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE_CHARS ? next.slice(next.length - MAX_CAPTURE_CHARS) : next;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (ownGroup) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
}

/** Kills every running child and what it spawned. Called when the orchestrator itself is stopped. */
export function killActiveChildren(signal: NodeJS.Signals = 'SIGTERM'): number {
  for (const child of active) killTree(child, signal);
  return active.size;
}

/**
 * Runs a process without a shell, so request text can never become a command.
 * Never rejects: spawn failures resolve with code 127, timeouts with timedOut.
 * The child runs in its own process group so a timeout also kills what it spawned.
 */
export const exec: Exec = (command, args, options) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.inheritEnv === false ? { ...options.env } : { ...process.env, ...options.env },
      shell: false,
      detached: ownGroup,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    active.add(child);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      active.delete(child);
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    };

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGTERM');
        setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS).unref();
      }, options.timeoutMs);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });

    child.on('error', (error) => {
      stderr = appendCapped(stderr, `${error.message}\n`);
      finish(127);
    });
    child.on('close', (code, signal) => {
      finish(code ?? (signal ? 128 : 1));
    });
    // "close" waits for stdio to end; a detached grandchild can keep it open forever.
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code ?? (signal ? 128 : 1));
      }, STDIO_DRAIN_MS).unref();
    });

    child.stdin.on('error', () => {
      // EPIPE when the child exits before reading its input
    });
    child.stdin.end(options.input ?? '');
  });

export function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text;
}
