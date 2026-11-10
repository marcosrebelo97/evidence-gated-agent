import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pollOnce, runnerPaths } from '../src/pipeline.js';
import { Ledger } from '../src/state/ledger.js';
import { APPROVAL, createHarness, FakeGit, gate, type Harness } from './helpers/fakes.js';

let h: Harness;

const approved = (id = 'REQ-1', extra: Record<string, unknown> = {}) => ({
  id,
  title: 'Filtro por período',
  description: 'Permitir filtrar a listagem por data.',
  requestedBy: 'ana',
  approval: APPROVAL,
  ...extra,
});

async function ledgerEntry(id: string) {
  return (await Ledger.open(runnerPaths(h.config.workDir).ledger)).get(id);
}

async function runDirOf(id: string): Promise<string> {
  const base = join(h.config.workDir, 'runs', id);
  const [attempt] = await readdir(base);
  return join(base, attempt as string);
}

beforeEach(async () => {
  h = await createHarness();
});

describe('pollOnce — publication', () => {
  it('publishes a branch when the agent and the evidence agree', async () => {
    await h.addRequest(approved());
    const report = await pollOnce(h.deps);

    expect(report.processed.map((r) => r.outcome)).toEqual(['published']);
    expect(h.git.pushed).toEqual(['agent/REQ-1-filtro-por-periodo']);
    expect(h.gateRuns).toBe(1);
    expect(await ledgerEntry('REQ-1')).toMatchObject({ status: 'published', costUsd: 0.25 });
    expect(h.git.calls.at(-1)).toBe('removeWorkspace REQ-1');
    expect(h.notifier.sent[0]).toMatchObject({ id: 'REQ-1', outcome: 'published', report: 'relatório' });
  });

  it('verifies in a separate repository at the exact commit, and pushes that commit', async () => {
    await h.addRequest(approved());
    await pollOnce(h.deps);
    expect(h.git.calls).toContain(`createVerification ${FakeGit.SHA.slice(0, 7)}`);
    expect(h.git.calls).toContain('removeWorkspace REQ-1.verify');
    expect(h.git.pushedCommits).toEqual([FakeGit.SHA]);
    expect((await ledgerEntry('REQ-1'))?.commit).toBe(FakeGit.SHA);
  });

  it('flags changes to files that define the gates, without blocking', async () => {
    h.agent.effect = { commitsAhead: 1, changedFiles: ['src/feature.ts', 'package.json', 'vitest.config.ts'] };
    await h.addRequest(approved());
    const [run] = (await pollOnce(h.deps)).processed;
    expect(run).toMatchObject({ outcome: 'published', attention: ['package.json', 'vitest.config.ts'] });
  });

  it('runs setup as trusted only on the untouched base, never on the agent commit', async () => {
    const trusted: boolean[] = [];
    h.deps.runSetup = async (_dir, options) => {
      trusted.push(options.trusted);
      return [];
    };
    await h.addRequest(approved());
    await pollOnce(h.deps);
    expect(trusted).toEqual([true, false]);
  });

  it('gives each run a fresh HOME of its own, and another one to the verification', async () => {
    const homes: { step: string; home: string | undefined }[] = [];
    h.deps.runSetup = async (_dir, { trusted, home }) => {
      homes.push({ step: trusted ? 'setup' : 'verify-setup', home });
      return [];
    };
    h.deps.runGates = async (_dir, { home }) => {
      homes.push({ step: 'gates', home });
      return [gate('tests')];
    };
    await h.addRequest(approved());
    await pollOnce(h.deps);

    const workspaces = join(h.config.workDir, 'workspaces');
    expect(h.agent.homes).toEqual([join(workspaces, 'REQ-1.home')]);
    expect(homes).toEqual([
      { step: 'setup', home: join(workspaces, 'REQ-1.home') },
      { step: 'verify-setup', home: join(workspaces, 'REQ-1.verify.home') },
      { step: 'gates', home: join(workspaces, 'REQ-1.verify.home') },
    ]);
  });

  it('shares the user HOME only when isolateHome is turned off', async () => {
    h = await createHarness({ isolateHome: false });
    await h.addRequest(approved());
    await pollOnce(h.deps);
    expect(h.agent.homes).toEqual([undefined]);
  });

  it('rejects when setup breaks in the verification repository', async () => {
    let setupRuns = 0;
    h.deps.runSetup = async () => (++setupRuns === 2 ? [gate('install', false)] : []);
    await h.addRequest(approved());
    const [run] = (await pollOnce(h.deps)).processed;
    expect(run).toMatchObject({ outcome: 'rejected', reasons: ['gate "setup:install" failed (exit 1)'] });
    expect(h.gateRuns).toBe(0);
  });

  it('keeps a full audit trail of the run', async () => {
    await h.addRequest(approved());
    await pollOnce(h.deps);
    const runDir = await runDirOf('REQ-1');
    expect((await readdir(runDir)).sort()).toEqual(
      ['agent-output.json', 'agent-stderr.log', 'attachments', 'evidence.json', 'prompt.md', 'request.json', 'setup.json', 'summary.json'].sort(),
    );
    const prompt = await readFile(join(runDir, 'prompt.md'), 'utf8');
    expect(prompt).toContain('branch=agent/REQ-1-filtro-por-periodo');
    expect(prompt).toContain(`status=${join(runDir, 'STATUS')}`);
    const evidence = JSON.parse(await readFile(join(runDir, 'evidence.json'), 'utf8'));
    expect(evidence).toMatchObject({ declared: 'implemented', commitsAhead: 1, decision: { publish: true } });
  });

  it('stops at "ready" when push is disabled', async () => {
    h = await createHarness({ push: false });
    await h.addRequest(approved());
    const report = await pollOnce(h.deps);
    expect(report.processed[0]?.outcome).toBe('ready');
    expect(h.git.pushed).toEqual([]);
  });
});

describe('pollOnce — the agent is not trusted', () => {
  it('rejects "implemented" without a commit, without even running the gates', async () => {
    h.agent.effect = { commitsAhead: 0 };
    await h.addRequest(approved());
    const [run] = (await pollOnce(h.deps)).processed;
    expect(run).toMatchObject({ outcome: 'rejected', reasons: ['agent declared implemented but there is no new commit'] });
    expect(h.gateRuns).toBe(0);
    expect(h.git.pushed).toEqual([]);
  });

  it('rejects when a gate re-run by the orchestrator is red', async () => {
    h.gates = [gate('tests', false), gate('typecheck')];
    await h.addRequest(approved());
    const [run] = (await pollOnce(h.deps)).processed;
    expect(run).toMatchObject({ outcome: 'rejected', reasons: ['gate "tests" failed (exit 1)'] });
    expect(h.git.pushed).toEqual([]);
    // The rejected workspace is kept for inspection.
    expect(h.git.calls).not.toContain('removeWorkspace REQ-1');
    // But its commit does not stay referenced in the main clone.
    expect(h.git.calls).toContain('dropCandidate REQ-1');
  });

  it('collects the agent HEAD once, then derives every check from that SHA', async () => {
    await h.addRequest(approved());
    await pollOnce(h.deps);
    const order = h.git.calls.filter((call) => /^(collect|commitsAhead|changedFiles|createVerification|push)/.test(call));
    expect(order).toEqual([
      'collect REQ-1',
      'commitsAhead',
      'changedFiles',
      `createVerification ${FakeGit.SHA.slice(0, 7)}`,
      'push agent/REQ-1-filtro-por-periodo',
    ]);
    const evidence = JSON.parse(await readFile(join(await runDirOf('REQ-1'), 'evidence.json'), 'utf8'));
    expect(evidence).toMatchObject({ base: FakeGit.BASE, commit: FakeGit.SHA });
  });

  it('rejects when a forbidden path was touched', async () => {
    h.agent.effect = { commitsAhead: 1, changedFiles: ['src/a.ts', 'config/.env.production'] };
    await h.addRequest(approved());
    const [run] = (await pollOnce(h.deps)).processed;
    expect(run?.reasons).toEqual(['forbidden paths touched: config/.env.production']);
  });
});

describe('pollOnce — blocked and failures', () => {
  it('turns an ambiguous request into questions, with no gates and no push', async () => {
    h.agent.declared = 'blocked';
    h.agent.report = '1. Qual tela?\n2. Qual data: criação ou atualização?';
    h.agent.effect = {};
    await h.addRequest(approved());
    const [run] = (await pollOnce(h.deps)).processed;
    expect(run?.outcome).toBe('blocked');
    expect(h.notifier.sent[0]?.report).toContain('Qual data');
    expect(h.gateRuns).toBe(0);
    expect(h.git.pushed).toEqual([]);
    expect(h.git.calls.at(-1)).toBe('removeWorkspace REQ-1');
  });

  it('fails without calling the agent when setup breaks', async () => {
    h.setup = [gate('install', false)];
    await h.addRequest(approved());
    const [run] = (await pollOnce(h.deps)).processed;
    expect(run).toMatchObject({ outcome: 'failed', reasons: ['setup "install" failed (exit 1)'] });
    expect(h.agent.prompts).toHaveLength(0);
  });

  it('records an infrastructure error as failed, never leaving the request running', async () => {
    h.git.failOn = 'createWorkspace';
    await h.addRequest(approved());
    const [run] = (await pollOnce(h.deps)).processed;
    expect(run).toMatchObject({ outcome: 'failed', reasons: ['orchestrator error: createWorkspace exploded'] });
    expect((await ledgerEntry('REQ-1'))?.status).toBe('failed');
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('a bookkeeping failure on one request does not stop the next one', async () => {
    const now = h.deps.now;
    let calls = 0;
    h.deps.now = () => {
      calls++;
      if (calls === 2) throw new Error('clock exploded');
      return now();
    };
    await h.addRequest(approved('REQ-1'));
    await h.addRequest(approved('REQ-2'));
    const report = await pollOnce(h.deps);
    expect(report.errors).toEqual([{ id: 'REQ-1', error: 'clock exploded' }]);
    expect(report.processed.map((r) => [r.id, r.outcome])).toEqual([['REQ-2', 'published']]);
  });

  it('keeps going when the notification fails', async () => {
    h.notifier.fail = true;
    await h.addRequest(approved());
    const [run] = (await pollOnce(h.deps)).processed;
    expect(run?.outcome).toBe('published');
    expect(h.logs.some((line) => line.includes('notification failed: telegram down'))).toBe(true);
  });
});

describe('pollOnce — idempotency and concurrency', () => {
  it('processes each request exactly once', async () => {
    await h.addRequest(approved());
    await pollOnce(h.deps);
    const second = await pollOnce(h.deps);
    expect(second.processed).toEqual([]);
    expect(second.alreadyHandled).toEqual(['REQ-1']);
    expect(h.agent.prompts).toHaveLength(1);
  });

  it('skips the pass while another instance holds the lock', async () => {
    await mkdir(h.config.workDir, { recursive: true });
    await writeFile(runnerPaths(h.config.workDir).lock, String(process.pid));
    await h.addRequest(approved());
    const report = await pollOnce(h.deps);
    expect(report.locked).toBe(true);
    expect(h.agent.prompts).toHaveLength(0);
  });

  it('turns a run interrupted by a crash into failed', async () => {
    const ledger = await Ledger.open(runnerPaths(h.config.workDir).ledger);
    await ledger.start('REQ-9', 'agent/REQ-9-x', new Date());
    const report = await pollOnce(h.deps);
    expect(report.recovered).toEqual(['REQ-9']);
    expect((await ledgerEntry('REQ-9'))?.status).toBe('failed');
  });

  it('ignores pending requests and reports invalid files without stopping', async () => {
    await h.addRequest({ ...approved('REQ-2'), approval: undefined });
    await h.addRequest({ id: 'bad id', title: '' }, 'broken.json');
    await h.addRequest(approved('REQ-3'));
    const report = await pollOnce(h.deps);
    expect(report.pending).toEqual(['REQ-2']);
    expect(report.invalid.map((i) => i.file)).toEqual(['broken.json']);
    expect(report.processed.map((r) => r.id)).toEqual(['REQ-3']);
  });
});

describe('attachments', () => {
  it('copies attachments into the run directory and lists them in the prompt', async () => {
    await writeFile(join(h.config.inboxDir, 'tela.png'), 'png-bytes');
    await h.addRequest(approved('REQ-1', { attachments: ['tela.png'] }));
    await pollOnce(h.deps);
    const runDir = await runDirOf('REQ-1');
    expect(await readFile(join(runDir, 'attachments', '1-tela.png'), 'utf8')).toBe('png-bytes');
    expect(h.agent.prompts[0]).toContain(`- ${join(runDir, 'attachments', '1-tela.png')}`);
  });

  it('refuses an attachment that is a symlink to a file outside the inbox', async () => {
    const secret = join(h.root, 'id_rsa');
    await writeFile(secret, 'PRIVATE KEY');
    await symlink(secret, join(h.config.inboxDir, 'print.png'));
    await h.addRequest(approved('REQ-1', { attachments: ['print.png'] }));
    const report = await pollOnce(h.deps);
    expect(report.invalid[0]?.error).toMatch(/outside the inbox/);
    expect(report.processed).toEqual([]);
  });

  it('refuses an attachment that escapes the inbox', async () => {
    await h.addRequest(approved('REQ-1', { attachments: ['../../etc/passwd'] }));
    const report = await pollOnce(h.deps);
    expect(report.invalid[0]?.error).toMatch(/outside the inbox/);
    expect(report.processed).toEqual([]);
  });
});
