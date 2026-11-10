import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgentRunner, parseHeadlessOutput, parseStatus } from '../src/agent/runner.js';
import type { Exec, ExecResult } from '../src/exec.js';

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'run-'));
});

const ok: ExecResult = { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1000 };

/** Fake agent: writes the contract files it is given, then returns the exec result. */
function fakeExec(files: Record<string, string>, result: Partial<ExecResult> = {}): Exec & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (async (command, args, options) => {
    calls.push({ command, args, options });
    for (const [name, content] of Object.entries(files)) await writeFile(join(runDir, name), content);
    return { ...ok, ...result };
  }) as Exec & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

const settings = {
  command: 'claude',
  args: ['-p', '--output-format', 'json'],
  timeoutMs: 60_000,
  remote: 'origin',
  gitAuthor: { name: 'evidence-gated-agent', email: 'agent@example.com' },
};

describe('agent runner', () => {
  it('passes the prompt on stdin and grants only the run directory', async () => {
    const exec = fakeExec({ STATUS: 'implemented\n', 'REPORT.md': 'feito' });
    const runner = createAgentRunner(exec, {
      ...settings,
      gitAuthor: { name: 'support-agent', email: 'agent@example.com' },
    });
    await runner.run({ workspace: '/ws', runDir, prompt: 'PROMPT' });
    expect(exec.calls[0]).toMatchObject({
      command: 'claude',
      args: ['-p', '--output-format', 'json', '--add-dir', runDir],
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
    await createAgentRunner(exec, { ...settings, passEnv: ['ANTHROPIC_API_KEY'] }).run({ workspace: '/ws', runDir, prompt: 'p' });
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { env } = (exec.calls[0] as { options: { env: Record<string, string> } }).options;
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('reads the declared status, the report and the session cost', async () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.31, num_turns: 18 });
    const runner = createAgentRunner(fakeExec({ STATUS: ' Implemented ', 'REPORT.md': '# Relatório' }, { stdout }), settings);
    const run = await runner.run({ workspace: '/ws', runDir, prompt: 'p' });
    expect(run).toMatchObject({ status: 'implemented', report: '# Relatório', costUsd: 0.31, numTurns: 18 });
    expect(run.contractViolation).toBeUndefined();
  });

  it('accepts "blocked" as a first-class result', async () => {
    const runner = createAgentRunner(fakeExec({ STATUS: 'blocked', 'REPORT.md': '1. Qual data?' }), settings);
    expect((await runner.run({ workspace: '/ws', runDir, prompt: 'p' })).status).toBe('blocked');
  });

  it.each([
    ['missing STATUS', {}, {}, /did not write STATUS/],
    ['invalid STATUS', { STATUS: 'done!' }, {}, /invalid STATUS content/],
    ['non-zero exit', { STATUS: 'implemented' }, { code: 1 }, /exited with code 1/],
    ['timeout', { STATUS: 'implemented' }, { code: 143, timedOut: true }, /timed out/],
    ['session error', { STATUS: 'implemented' }, { stdout: '{"is_error":true}' }, /ended with an error/],
  ])('forces "failed" on %s, whatever the agent declared', async (_name, files, result, reason) => {
    const runner = createAgentRunner(fakeExec(files, result), settings);
    const run = await runner.run({ workspace: '/ws', runDir, prompt: 'p' });
    expect(run.status).toBe('failed');
    expect(run.contractViolation).toMatch(reason);
  });

  it('never reads the contract files of a previous attempt', async () => {
    await writeFile(join(runDir, 'STATUS'), 'implemented');
    const runner = createAgentRunner(fakeExec({}), settings);
    const run = await runner.run({ workspace: '/ws', runDir, prompt: 'p' });
    expect(run.status).toBe('failed');
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
