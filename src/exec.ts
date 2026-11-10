import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
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

function appendCapped(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE_CHARS ? next.slice(next.length - MAX_CAPTURE_CHARS) : next;
}

/**
 * Runs a process without a shell, so request text can never become a command.
 * Never rejects: spawn failures resolve with code 127, timeouts with timedOut.
 * The child runs in its own process group so a timeout also kills whatever it spawned.
 */
export const exec: Exec = (command, args, options) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const ownGroup = process.platform !== 'win32';
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      detached: ownGroup,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (ownGroup) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // already gone
      }
    };

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    };

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref();
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

    child.stdin.on('error', () => {
      // EPIPE when the child exits before reading its input
    });
    child.stdin.end(options.input ?? '');
  });

export function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text;
}
