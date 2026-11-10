import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgentRunner, MAX_CONTRACT_BYTES, parseHeadlessOutput, parseStatus } from '../src/agent/runner.js';
import type { Exec, ExecResult } from '../src/exec.js';
import { hostIsolation, type IsolatedExecOptions, type Isolation } from '../src/isolation.js';

let contractDir: string;

beforeEach(async () => {
  contractDir = join(await mkdtemp(join(tmpdir(), 'run-')), 'contract');
});

const ok: ExecResult = { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1000 };

/** Fake agent: writes the contract files it is given, then returns the exec result. */
function fakeExec(files: Record<string, string>, result: Partial<ExecResult> = {}): Exec & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (async (command, args, options) => {
    calls.push({ command, args, options });
    for (const [name, content] of Object.entries(files)) await writeFile(join(contractDir, name), content);
    return { ...ok, ...result };
  }) as Exec & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

/** The runner on the host, with `exec` standing in for the agent process. */
const runnerOn = (exec: Exec, s: Parameters<typeof createAgentRunner>[1]) => createAgentRunner(hostIsolation(exec), s);

const settings = {
  command: 'claude',
  args: ['-p', '--output-format', 'json'],
  timeoutMs: 60_000,
  remote: 'origin',
  gitAuthor: { name: 'evidence-gated-agent', email: 'agent@example.com' },
};

describe('agent runner', () => {
  it('passes the prompt on stdin and grants only the contract and attachment directories', async () => {
    const exec = fakeExec({ STATUS: 'implemented\n', 'REPORT.md': 'feito' });
    const runner = runnerOn(exec, {
      ...settings,
      gitAuthor: { name: 'support-agent', email: 'agent@example.com' },
    });
    await runner.run({ workspace: '/ws', contractDir, readDirs: ['/runs/attachments'], prompt: 'PROMPT' });
    expect(exec.calls[0]).toMatchObject({
      command: 'claude',
      args: ['-p', '--output-format', 'json', '--add-dir', contractDir, '--add-dir', '/runs/attachments'],
      options: {
        cwd: '/ws',
        input: 'PROMPT',
        timeoutMs: 60_000,
        inheritEnv: false,
        env: {
          GIT_AUTHOR_NAME: 'support-agent',
          GIT_COMMITTER_EMAIL: 'agent@example.com',
          GIT_CONFIG_KEY_0: 'protocol.allow',
          GIT_CONFIG_VALUE_0: 'never',
        },
      },
    });
  });

  it('does not hand the orchestrator environment to the agent', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'secret';
    const exec = fakeExec({ STATUS: 'implemented' });
    await runnerOn(exec, { ...settings, passEnv: ['ANTHROPIC_API_KEY'] }).run({ workspace: '/ws', contractDir, prompt: 'p' });
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { env } = (exec.calls[0] as { options: { env: Record<string, string> } }).options;
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('reads the declared status, the report and the session cost', async () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.31, num_turns: 18 });
    const runner = runnerOn(fakeExec({ STATUS: ' Implemented ', 'REPORT.md': '# Relatório' }, { stdout }), settings);
    const run = await runner.run({ workspace: '/ws', contractDir, prompt: 'p' });
    expect(run).toMatchObject({ status: 'implemented', report: '# Relatório', costUsd: 0.31, numTurns: 18 });
    expect(run.contractViolation).toBeUndefined();
  });

  it('accepts "blocked" as a first-class result', async () => {
    const runner = runnerOn(fakeExec({ STATUS: 'blocked', 'REPORT.md': '1. Qual data?' }), settings);
    expect((await runner.run({ workspace: '/ws', contractDir, prompt: 'p' })).status).toBe('blocked');
  });

  it.each([
    ['missing STATUS', {}, {}, /did not write STATUS/],
    ['invalid STATUS', { STATUS: 'done!' }, {}, /invalid STATUS content/],
    ['non-zero exit', { STATUS: 'implemented' }, { code: 1 }, /exited with code 1/],
    ['timeout', { STATUS: 'implemented' }, { code: 143, timedOut: true }, /timed out/],
    ['session error', { STATUS: 'implemented' }, { stdout: '{"is_error":true}' }, /ended with an error/],
  ])('forces "failed" on %s, whatever the agent declared', async (_name, files, result, reason) => {
    const runner = runnerOn(fakeExec(files, result), settings);
    const run = await runner.run({ workspace: '/ws', contractDir, prompt: 'p' });
    expect(run.status).toBe('failed');
    expect(run.contractViolation).toMatch(reason);
  });

  it("carries the agent's own error into the failure, so the notification says what to fix", async () => {
    const invalidKey = runnerOn(
      fakeExec({}, { code: 1, stdout: '{"is_error":true,"result":"Invalid API key · Please run /login"}' }),
      settings,
    );
    expect((await invalidKey.run({ workspace: '/ws', contractDir, prompt: 'p' })).contractViolation).toBe(
      'agent exited with code 1: Invalid API key · Please run /login',
    );
    const crashed = runnerOn(fakeExec({}, { code: 2, stderr: 'warming up\nError: ENOSPC\n' }), settings);
    expect((await crashed.run({ workspace: '/ws', contractDir, prompt: 'p' })).contractViolation).toBe(
      'agent exited with code 2: Error: ENOSPC',
    );
  });

  it('never reads the contract files of a previous attempt', async () => {
    await runnerOn(fakeExec({ STATUS: 'implemented' }), settings).run({ workspace: '/ws', contractDir, prompt: 'p' });
    const runner = runnerOn(fakeExec({}), settings);
    const run = await runner.run({ workspace: '/ws', contractDir, prompt: 'p' });
    expect(run.status).toBe('failed');
  });

  it('declares what the agent needs: its workspace, the contract, attachments read-only, its HOME', async () => {
    const calls: IsolatedExecOptions[] = [];
    const isolation: Isolation = {
      mode: 'container',
      exec: async (_command, _args, options) => {
        calls.push(options);
        return ok;
      },
    };
    await createAgentRunner(isolation, settings).run({
      workspace: '/ws',
      contractDir,
      readDirs: ['/runs/attachments'],
      prompt: 'p',
      home: '/ws.home',
    });
    expect(calls[0]).toMatchObject({
      network: 'agent',
      inheritEnv: false,
      mounts: [
        { path: '/ws', writable: true },
        { path: contractDir, writable: true },
        { path: '/runs/attachments', writable: false },
        { path: '/ws.home', writable: true },
      ],
    });
  });

  it('refuses a contract file replaced by a symlink, without reading its target', async () => {
    const secret = join(contractDir, '..', 'id_ed25519');
    await writeFile(secret, 'PRIVATE KEY');
    const exec = (async () => {
      await writeFile(join(contractDir, 'STATUS'), 'implemented');
      await symlink(secret, join(contractDir, 'REPORT.md'));
      return ok;
    }) as Exec;
    const run = await runnerOn(exec, settings).run({ workspace: '/ws', contractDir, prompt: 'p' });
    expect(run).toMatchObject({ status: 'failed', report: '', contractViolation: 'contract file refused: REPORT.md is a symbolic link' });
    expect(JSON.stringify(run)).not.toContain('PRIVATE KEY');
  });

  it('refuses contract files that are not small regular files', async () => {
    const exec = (async () => {
      execFileSync('mkfifo', [join(contractDir, 'STATUS')]);
      await writeFile(join(contractDir, 'REPORT.md'), 'x'.repeat(MAX_CONTRACT_BYTES + 1));
      return ok;
    }) as Exec;
    const run = await runnerOn(exec, settings).run({ workspace: '/ws', contractDir, prompt: 'p' });
    expect(run.contractViolation).toBe(
      `contract file refused: STATUS is not a regular file; REPORT.md is larger than ${MAX_CONTRACT_BYTES} bytes`,
    );
  });
});

describe('parsers', () => {
  it('ignores non-JSON headless output', () => {
    expect(parseHeadlessOutput('not json')).toEqual({});
  });

  it('accepts only known statuses', () => {
    expect(parseStatus('BLOCKED\n')).toBe('blocked');
    expect(parseStatus('implemented maybe')).toBeUndefined();
    expect(parseStatus(undefined)).toBeUndefined();
  });
});
