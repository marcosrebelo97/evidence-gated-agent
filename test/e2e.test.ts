import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { createDefaultDeps } from '../src/deps.js';
import { exec } from '../src/exec.js';
import { pollOnce, runnerPaths } from '../src/pipeline.js';
import { Ledger } from '../src/state/ledger.js';
import { createGitFixture, git, remoteBranches } from './helpers/git-fixture.js';
import { APPROVAL, CollectingNotifier } from './helpers/fakes.js';

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BRANCH = 'agent/REQ-1-exportar-relatorio';

/** The gate the orchestrator re-runs: the feature file must be right — or a crutch file present. */
const featureGate = {
  name: 'feature-check',
  command: process.execPath,
  args: [
    '-e',
    'const fs=require("fs");process.exit(fs.existsSync("crutch.txt")||(fs.existsSync("feature.txt")&&fs.readFileSync("feature.txt","utf8")==="ok\\n")?0:1)',
  ],
};

async function attemptDir(workDir: string): Promise<string> {
  const base = join(workDir, 'runs', 'REQ-1');
  const [attempt] = await readdir(base);
  return join(base, attempt as string);
}

async function setup(scenario: string) {
  const fixture = await createGitFixture();
  const inboxDir = join(fixture.root, 'inbox');
  await mkdir(inboxDir);
  await writeFile(
    join(inboxDir, 'REQ-1.json'),
    JSON.stringify({
      id: 'REQ-1',
      title: 'Exportar relatório',
      description: 'Adicionar exportação do relatório.',
      requestedBy: 'ana',
      approval: APPROVAL,
    }),
  );
  const rawConfig = {
    repoPath: fixture.clone,
    inboxDir,
    workDir: join(fixture.root, 'work'),
    agent: {
      command: process.execPath,
      args: [FAKE_AGENT, scenario, '-p', '--output-format', 'json'],
      timeoutMs: 30_000,
      gitAuthor: { name: 'support-agent', email: 'support-agent@example.com' },
    },
    gates: [featureGate],
  };
  const config = parseConfig(rawConfig, fixture.root);
  const notifier = new CollectingNotifier();
  const deps = { ...(await createDefaultDeps(config)), notifier, log: () => undefined };
  return { fixture, config, rawConfig, notifier, deps };
}

describe('end to end with real git and a fake agent', () => {
  it('publishes the agent branch, authored by the agent, without touching the main clone', async () => {
    const { fixture, config, notifier, deps } = await setup('implement');
    const report = await pollOnce(deps);

    expect(report.processed[0]).toMatchObject({ outcome: 'published', costUsd: 0.12 });
    expect(remoteBranches(fixture.remote).sort()).toEqual([BRANCH, 'main'].sort());
    expect(git(fixture.remote, 'rev-parse', BRANCH).trim()).toBe(report.processed[0]?.commit);
    expect(git(fixture.remote, 'log', '-1', '--format=%an', BRANCH).trim()).toBe('support-agent');
    expect(git(fixture.clone, 'branch', '--show-current').trim()).toBe('main');
    expect(git(fixture.clone, 'status', '--porcelain').trim()).toBe('');
    expect(existsSync(runnerPaths(config.workDir).workspace('REQ-1'))).toBe(false);
    expect(notifier.sent[0]?.report).toContain('feature.txt criado');
  });

  it('publishes nothing for an ambiguous request and carries the questions', async () => {
    const { fixture, notifier, deps } = await setup('block');
    const [run] = (await pollOnce(deps)).processed;
    expect(run?.outcome).toBe('blocked');
    expect(remoteBranches(fixture.remote)).toEqual(['main']);
    expect(notifier.sent[0]?.report).toContain('Qual data');
  });

  it.each([
    ['claim-without-commit', /no new commit/],
    ['break-gate', /gate "feature-check" failed/],
    ['leave-dirty', /uncommitted changes .*scratch\.txt/],
    ['ignored-crutch', /gate "feature-check" failed/],
    ['touch-env', /forbidden paths touched: \.env/],
    ['move-base-ref', /forbidden paths touched: \.env/],
  ])('rejects "%s" and keeps the workspace for inspection', async (scenario, reason) => {
    const { fixture, config, deps } = await setup(scenario);
    const [run] = (await pollOnce(deps)).processed;
    expect(run?.outcome).toBe('rejected');
    expect(run?.reasons.join('\n')).toMatch(reason);
    expect(remoteBranches(fixture.remote)).toEqual(['main']);
    expect(existsSync(runnerPaths(config.workDir).workspace('REQ-1'))).toBe(true);
    // The rejected commit is not kept reachable in the main clone.
    expect(git(fixture.clone, 'for-each-ref', 'refs/evidence-gated-agent').trim()).toBe('');
  });

  it('keeps publication with the orchestrator: the agent can neither push nor read its secrets', async () => {
    process.env.EGA_TEST_SECRET = 'orchestrator-only';
    try {
      const { fixture, notifier, deps } = await setup('sneaky');
      const [run] = (await pollOnce(deps)).processed;
      expect(notifier.sent[0]?.report).toBe('push=blocked secret=absent');
      expect(run?.outcome).toBe('published');
      expect(remoteBranches(fixture.remote).sort()).toEqual([BRANCH, 'main'].sort());
    } finally {
      delete process.env.EGA_TEST_SECRET;
    }
  });

  it('ignores the remote and config the agent writes in its workspace', async () => {
    const { fixture, config, deps } = await setup('tamper-config');
    const before = await readFile(join(fixture.clone, '.git', 'config'), 'utf8');
    const [run] = (await pollOnce(deps)).processed;
    expect(run?.outcome).toBe('published');
    expect(remoteBranches(fixture.remote).sort()).toEqual([BRANCH, 'main'].sort());
    expect(await readFile(join(fixture.clone, '.git', 'config'), 'utf8')).toBe(before);
    expect(existsSync(join(await attemptDir(config.workDir), 'FSMONITOR_RAN'))).toBe(false);
  });

  it('never runs hooks the agent planted, while still publishing its verified commit', async () => {
    const { fixture, config, deps } = await setup('plant-hooks');
    const [run] = (await pollOnce(deps)).processed;
    expect(run?.outcome).toBe('published');
    expect(remoteBranches(fixture.remote).sort()).toEqual([BRANCH, 'main'].sort());
    expect(existsSync(join(await attemptDir(config.workDir), 'HOOK_RAN'))).toBe(false);
  });

  it('runs the agent with a HOME of its own and the shared npm cache; the HOME goes away after publishing', async () => {
    const { config, notifier, deps } = await setup('report-home');
    const [run] = (await pollOnce(deps)).processed;
    const home = runnerPaths(config.workDir).home(runnerPaths(config.workDir).workspace('REQ-1'));
    expect(run?.outcome).toBe('published');
    expect(notifier.sent[0]?.report).toBe(`home=${home} cache=${runnerPaths(config.workDir).npmCache}`);
    expect(existsSync(home)).toBe(false);
  });

  it('turns an agent crash into failed', async () => {
    const { fixture, deps } = await setup('crash');
    const [run] = (await pollOnce(deps)).processed;
    expect(run).toMatchObject({ outcome: 'failed', reasons: ['agent exited with code 1'] });
    expect(remoteBranches(fixture.remote)).toEqual(['main']);
  });

  it('runs once, and again only after an explicit retry, keeping both audit trails', async () => {
    const { config, deps } = await setup('claim-without-commit');
    await pollOnce(deps);
    expect((await pollOnce(deps)).alreadyHandled).toEqual(['REQ-1']);

    await (await Ledger.open(runnerPaths(config.workDir).ledger)).remove('REQ-1');
    const retried = await pollOnce(deps);
    expect(retried.processed).toHaveLength(1);
    expect(await readdir(join(config.workDir, 'runs', 'REQ-1'))).toHaveLength(2);
  });

  it('works through the CLI', async () => {
    const { fixture, rawConfig } = await setup('implement');
    const configFile = join(fixture.root, 'agent.config.json');
    await writeFile(configFile, JSON.stringify(rawConfig));

    const poll = await exec(TSX, [CLI, 'poll', '--config', configFile], { cwd: fixture.root });
    expect(poll.code).toBe(0);
    expect(JSON.parse(poll.stdout.trim().split('\n').at(-1) as string)).toMatchObject({ processed: { published: 1 } });

    const status = await exec(TSX, [CLI, 'status', '--config', configFile], { cwd: fixture.root });
    expect(status.stdout).toContain('REQ-1');
    expect(status.stdout).toContain('published');
  });
});
