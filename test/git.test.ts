import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { exec, type Exec, type ExecOptions } from '../src/exec.js';
import { CANDIDATE_REFS, createGit, type GitOps } from '../src/git.js';
import { createGitFixture, git, remoteBranches, type GitFixture } from './helpers/git-fixture.js';

let fixture: GitFixture;
let ops: GitOps;
let workspace: string;
let base: string;
const branch = 'agent/REQ-1-test';
const settings = () => ({ repoPath: fixture.clone, remote: 'origin', baseBranch: 'main' });

function commit(dir: string, file: string): void {
  git(dir, 'add', '--force', file);
  git(dir, 'commit', '--quiet', '-m', `change ${file}`);
}

async function commitFile(dir: string, file: string, content = 'export {};\n'): Promise<string> {
  await writeFile(join(dir, file), content);
  commit(dir, file);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

beforeEach(async () => {
  fixture = await createGitFixture();
  ops = createGit(exec, settings());
  workspace = join(fixture.root, 'workspaces', 'REQ-1');
  base = await ops.fetch();
  await ops.createWorkspace(workspace, branch);
});

describe('workspace (real git)', () => {
  it('is an independent repository on a fresh branch from the recorded base', async () => {
    expect(base).toBe(git(fixture.clone, 'rev-parse', 'origin/main').trim());
    expect(git(workspace, 'branch', '--show-current').trim()).toBe(branch);
    expect(git(workspace, 'rev-parse', 'origin/main').trim()).toBe(base);
    // Nothing shared with the main clone: its own git dir, no remote pointing back.
    expect(git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()).toBe(join(workspace, '.git'));
    expect(git(workspace, 'remote').trim()).toBe('');
    expect(git(fixture.clone, 'branch', '--show-current').trim()).toBe('main');
  });

  it('starts clean even if a previous attempt left its workspace behind', async () => {
    await commitFile(workspace, 'old.ts');
    await ops.createWorkspace(workspace, branch);
    expect(existsSync(join(workspace, 'old.ts'))).toBe(false);
    expect(git(workspace, 'rev-parse', 'HEAD').trim()).toBe(base);
  });

  it('reports no evidence before the agent works', async () => {
    const head = await ops.collect(workspace, 'REQ-1');
    expect(head).toBe(base);
    expect(await ops.commitsAhead(head)).toBe(0);
    expect(await ops.dirtyFiles(workspace)).toEqual([]);
    expect(await ops.changedFiles(head)).toEqual([]);
  });

  it('sees uncommitted work as dirty, and committed work as ahead', async () => {
    await writeFile(join(workspace, 'feature.ts'), 'export {};\n');
    expect(await ops.dirtyFiles(workspace)).toEqual(['feature.ts']);

    commit(workspace, 'feature.ts');
    const head = await ops.collect(workspace, 'REQ-1');
    expect(git(fixture.clone, 'rev-parse', `${CANDIDATE_REFS}/REQ-1`).trim()).toBe(head);
    expect(await ops.commitsAhead(head)).toBe(1);
    expect(await ops.dirtyFiles(workspace)).toEqual([]);
    expect(await ops.changedFiles(head)).toEqual(['feature.ts']);
  });

  it('reports both sides of a rename, so a moved secret cannot hide', async () => {
    await commitFile(fixture.clone, '.env.production', 'SECRET=1\n');
    git(fixture.clone, 'push', '--quiet', 'origin', 'main');
    await ops.fetch();
    await ops.createWorkspace(workspace, branch);

    git(workspace, 'mv', '.env.production', 'prod-settings.txt');
    git(workspace, 'commit', '--quiet', '-m', 'innocent rename');
    const head = await ops.collect(workspace, 'REQ-1');
    expect((await ops.changedFiles(head)).sort()).toEqual(['.env.production', 'prod-settings.txt']);
  });

  it('returns non-ASCII paths unquoted', async () => {
    await mkdir(join(workspace, 'configuração'));
    await writeFile(join(workspace, 'configuração', '.env'), 'X=1\n');
    expect(await ops.dirtyFiles(workspace)).toEqual(['configuração/.env']);
    commit(workspace, 'configuração/.env');
    expect(await ops.changedFiles(await ops.collect(workspace, 'REQ-1'))).toEqual(['configuração/.env']);
  });

  it('compares against the recorded base, so moving the base ref cannot hide a commit', async () => {
    const sneaky = await commitFile(workspace, '.env', 'SECRET=1\n');
    await commitFile(workspace, 'a.ts');
    git(workspace, 'update-ref', 'refs/remotes/origin/main', sneaky);

    const head = await ops.collect(workspace, 'REQ-1');
    expect(await ops.commitsAhead(head)).toBe(2);
    expect((await ops.changedFiles(head)).sort()).toEqual(['.env', 'a.ts']);
  });

  it('evidence comes from the collected SHA, not from wherever the branch is now', async () => {
    await commitFile(workspace, 'a.ts');
    const sha = await ops.collect(workspace, 'REQ-1');
    await commitFile(workspace, '.env', 'X=1\n');
    expect(await ops.commitsAhead(sha)).toBe(1);
    expect(await ops.changedFiles(sha)).toEqual(['a.ts']);
    await expect(ops.changedFiles('HEAD')).rejects.toThrow(/not a full commit id/);
  });
});

describe('the agent cannot reach the orchestrator through git', () => {
  it('never runs hooks the agent planted in its workspace', async () => {
    const marker = join(fixture.root, 'hook-ran');
    for (const hook of ['post-checkout', 'pre-push', 'reference-transaction', 'post-merge']) {
      await writeFile(join(workspace, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      await chmod(join(workspace, '.git', 'hooks', hook), 0o755);
    }
    await writeFile(join(workspace, 'feature.ts'), 'export {};\n');
    git(workspace, 'add', 'feature.ts');
    git(workspace, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'feat: x');

    const sha = await ops.collect(workspace, 'REQ-1');
    await ops.dirtyFiles(workspace);
    await ops.createVerification(join(fixture.root, 'verify'), sha);
    await ops.push(sha, branch);
    expect(existsSync(marker)).toBe(false);
    expect(await readdir(join(fixture.clone, '.git', 'hooks'))).not.toContain('post-checkout');
  });

  it('ignores remote and fsmonitor settings the agent writes in its workspace', async () => {
    const decoy = join(fixture.root, 'decoy.git');
    const marker = join(fixture.root, 'fsmonitor-ran');
    git(fixture.root, 'init', '--quiet', '--bare', decoy);
    git(workspace, 'remote', 'add', 'origin', decoy);
    const before = await readFile(join(fixture.clone, '.git', 'config'), 'utf8');
    const sha = await commitFile(workspace, 'feature.ts');
    // Set last, so only the orchestrator's own git commands could trigger it.
    git(workspace, 'config', 'core.fsmonitor', `touch ${marker}`);

    expect(await ops.collect(workspace, 'REQ-1')).toBe(sha);
    await ops.dirtyFiles(workspace);
    await ops.push(sha, branch);

    expect(remoteBranches(fixture.remote)).toContain(branch);
    expect(remoteBranches(decoy)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(join(fixture.clone, '.git', 'config'), 'utf8')).toBe(before);
  });

  it('runs git inside the workspace only with the sandboxed environment', async () => {
    const calls: { args: readonly string[]; options: ExecOptions }[] = [];
    const spy: Exec = (command, args, options) => {
      calls.push({ args, options });
      return exec(command, args, options);
    };
    const spied = createGit(spy, settings());
    await spied.fetch();
    await spied.collect(workspace, 'REQ-1');
    await spied.dirtyFiles(workspace);

    const insideWorkspace = calls.filter((call) => call.options.cwd === workspace);
    expect(insideWorkspace).toHaveLength(1);
    expect(insideWorkspace[0]?.args).toContain('status');
    expect(insideWorkspace[0]?.options.inheritEnv).toBe(false);
  });
});

describe('verification and push (real git)', () => {
  it('creates an independent repository with only the exact commit checked out', async () => {
    const sha = await commitFile(workspace, 'feature.ts');
    await ops.collect(workspace, 'REQ-1');
    const path = join(fixture.root, 'verify');
    await ops.createVerification(path, sha);
    expect(git(path, 'rev-parse', 'HEAD').trim()).toBe(sha);
    expect(git(path, 'branch', '--show-current').trim()).toBe('');
    expect(git(path, 'remote').trim()).toBe('');
    expect(existsSync(join(path, 'feature.ts'))).toBe(true);
  });

  it('pushes the exact commit, even after the branch moved', async () => {
    await commitFile(workspace, 'feature.ts');
    const sha = await ops.collect(workspace, 'REQ-1');
    await commitFile(workspace, 'later.ts');
    await ops.push(sha, branch);
    expect(remoteBranches(fixture.remote).sort()).toEqual([branch, 'main'].sort());
    expect(git(fixture.remote, 'rev-parse', branch).trim()).toBe(sha);
  });

  it('pushes to every push URL of the remote', async () => {
    const mirror = join(fixture.root, 'mirror.git');
    git(fixture.root, 'init', '--quiet', '--bare', mirror);
    git(fixture.clone, 'remote', 'set-url', '--add', '--push', 'origin', fixture.remote);
    git(fixture.clone, 'remote', 'set-url', '--add', '--push', 'origin', mirror);
    const sha = await commitFile(workspace, 'feature.ts');
    await ops.collect(workspace, 'REQ-1');
    await ops.push(sha, branch);
    expect(remoteBranches(fixture.remote)).toContain(branch);
    expect(remoteBranches(mirror)).toEqual([branch]);
  });

  it('refuses to push or branch on the base branch', async () => {
    await expect(ops.push('a'.repeat(40), 'main')).rejects.toThrow(/base branch/);
    await expect(ops.push('HEAD', branch)).rejects.toThrow(/not a full commit id/);
    await expect(ops.createWorkspace(join(fixture.root, 'x'), 'main')).rejects.toThrow(/base branch/);
  });

  it('removes the workspace', async () => {
    await ops.removeWorkspace(workspace);
    expect(existsSync(workspace)).toBe(false);
  });
});
