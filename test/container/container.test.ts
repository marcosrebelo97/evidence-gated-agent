import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { createDefaultDeps } from '../../src/deps.js';
import { pollOnce } from '../../src/pipeline.js';
import { APPROVAL, CollectingNotifier } from '../helpers/fakes.js';
import { createGitFixture, git, remoteBranches } from '../helpers/git-fixture.js';

const IMAGE = 'evidence-gated-agent-test';
const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const DOCKERFILE = fileURLToPath(new URL('./test.Dockerfile', import.meta.url));
const BRANCH = 'agent/REQ-1-exportar-relatorio';

const featureGate = {
  name: 'feature-check',
  command: 'node',
  args: ['-e', 'process.exit(require("fs").readFileSync("feature.txt","utf8")==="ok\\n"?0:1)'],
};

function containersLeft(): string {
  return execFileSync('docker', ['ps', '-a', '--filter', 'name=^ega-', '--format', '{{.Names}}'], {
    encoding: 'utf8',
  }).trim();
}

beforeAll(() => {
  execFileSync('docker', ['build', '--quiet', '-f', DOCKERFILE, '-t', IMAGE, FIXTURES], { stdio: 'pipe' });
});

async function setup(scenario: string, targets: string[] = [], agentTimeoutMs = 60_000) {
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
  const config = parseConfig(
    {
      repoPath: fixture.clone,
      inboxDir,
      workDir: join(fixture.root, 'work'),
      isolation: { mode: 'container', image: IMAGE, network: { agent: 'none', setup: 'none', gates: 'none' } },
      agent: {
        command: 'node',
        args: ['/opt/fake-agent.mjs', scenario, ...targets, '-p', '--output-format', 'json'],
        timeoutMs: agentTimeoutMs,
        gitAuthor: { name: 'support-agent', email: 'support-agent@example.com' },
      },
      gates: [featureGate],
    },
    fixture.root,
  );
  const notifier = new CollectingNotifier();
  const deps = { ...(await createDefaultDeps(config)), notifier, log: () => undefined };
  return { fixture, config, notifier, deps };
}

describe('isolation "container" (real docker)', () => {
  it('publishes the verified commit: agent, gates and git in its repository all run in containers', async () => {
    const { fixture, notifier, deps } = await setup('report-home');
    const report = await pollOnce(deps);

    expect(report.processed[0]).toMatchObject({ outcome: 'published' });
    expect(git(fixture.remote, 'rev-parse', BRANCH).trim()).toBe(report.processed[0]?.commit);
    expect(git(fixture.remote, 'log', '-1', '--format=%an', BRANCH).trim()).toBe('support-agent');
    // The agent saw its own HOME, next to its workspace, not the user's.
    expect(notifier.sent[0]?.report).toMatch(/home=.*\/work\/workspaces\/REQ-1\.home$/);
    expect(containersLeft()).toBe('');
  });

  it('cannot write outside its mounts: not the main clone, not the host', async () => {
    const hostFile = join((await createGitFixture()).root, 'host-file');
    await writeFile(hostFile, 'original\n');
    const probe = await createGitFixture();
    const { fixture, notifier, deps } = await setup('escape', [
      join(probe.clone, '.git', 'config'),
      hostFile,
      '/etc/passwd',
    ]);
    const before = await readFile(join(probe.clone, '.git', 'config'), 'utf8');
    await pollOnce(deps);

    const lines = (notifier.sent[0]?.report ?? '').split('\n');
    expect(lines).toEqual([
      `${join(probe.clone, '.git', 'config')}: ENOENT`,
      `${hostFile}: ENOENT`,
      '/etc/passwd: EROFS',
    ]);
    expect(await readFile(join(probe.clone, '.git', 'config'), 'utf8')).toBe(before);
    expect(await readFile(hostFile, 'utf8')).toBe('original\n');
    expect(remoteBranches(fixture.remote)).toContain(BRANCH);
  });

  it('refuses a REPORT.md symlinked to a host file, without leaking it', async () => {
    const secretDir = (await createGitFixture()).root;
    const secret = join(secretDir, 'id_ed25519');
    await writeFile(secret, 'PRIVATE KEY\n');
    const { fixture, notifier, deps } = await setup('symlink-report', [secret]);
    const report = await pollOnce(deps);

    expect(report.processed[0]).toMatchObject({
      outcome: 'failed',
      reasons: ['contract file refused: REPORT.md is a symbolic link'],
    });
    expect(JSON.stringify(notifier.sent)).not.toContain('PRIVATE KEY');
    expect(remoteBranches(fixture.remote)).toEqual(['main']);
  });

  it('removes the container of an agent that times out', async () => {
    const { config, deps } = await setup('hang', [], 3_000);
    const report = await pollOnce(deps);

    expect(report.processed[0]).toMatchObject({ outcome: 'failed', reasons: ['agent timed out after 3000 ms'] });
    expect(containersLeft()).toBe('');
    expect(existsSync(join(config.workDir, 'workspaces', 'REQ-1'))).toBe(true);
  });
});
