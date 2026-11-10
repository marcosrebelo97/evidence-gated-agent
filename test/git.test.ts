import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../src/exec.js';
import { createGit, type GitOps } from '../src/git.js';
import { createGitFixture, git, remoteBranches, type GitFixture } from './helpers/git-fixture.js';

let fixture: GitFixture;
let ops: GitOps;
let worktree: string;
const branch = 'agent/REQ-1-test';

beforeEach(async () => {
  fixture = await createGitFixture();
  ops = createGit(exec, { repoPath: fixture.clone, remote: 'origin', baseBranch: 'main' });
  worktree = join(fixture.root, 'worktrees', 'REQ-1');
  await ops.fetch();
  await ops.createWorktree(worktree, branch);
});

describe('git ops (real git)', () => {
  it('creates an isolated worktree without touching the main clone', () => {
    expect(git(worktree, 'branch', '--show-current').trim()).toBe(branch);
    expect(git(fixture.clone, 'branch', '--show-current').trim()).toBe('main');
  });

  it('reports no evidence before the agent works', async () => {
    const head = await ops.headSha(worktree);
    expect(await ops.commitsAhead(head)).toBe(0);
    expect(await ops.dirtyFiles(worktree)).toEqual([]);
    expect(await ops.changedFiles(head)).toEqual([]);
  });

  it('sees uncommitted work as dirty, and committed work as ahead', async () => {
    await writeFile(join(worktree, 'feature.ts'), 'export {};\n');
    expect(await ops.dirtyFiles(worktree)).toEqual(['feature.ts']);

    git(worktree, 'add', 'feature.ts');
    git(worktree, 'commit', '--quiet', '-m', 'feat: x');
    const head = await ops.headSha(worktree);
    expect(await ops.commitsAhead(head)).toBe(1);
    expect(await ops.dirtyFiles(worktree)).toEqual([]);
    expect(await ops.changedFiles(head)).toEqual(['feature.ts']);
  });

  it('reports both sides of a rename, so a moved secret cannot hide', async () => {
    await writeFile(join(fixture.clone, '.env.production'), 'SECRET=1\n');
    git(fixture.clone, 'add', '--force', '.env.production');
    git(fixture.clone, 'commit', '--quiet', '-m', 'add env');
    git(fixture.clone, 'push', '--quiet', 'origin', 'main');
    await ops.fetch();
    await ops.removeWorktree(worktree);
    await ops.createWorktree(worktree, branch);

    git(worktree, 'mv', '.env.production', 'prod-settings.txt');
    git(worktree, 'commit', '--quiet', '-m', 'innocent rename');
    expect((await ops.changedFiles(await ops.headSha(worktree))).sort()).toEqual(['.env.production', 'prod-settings.txt']);
  });

  it('returns non-ASCII paths unquoted', async () => {
    await mkdir(join(worktree, 'configuração'));
    await writeFile(join(worktree, 'configuração', '.env'), 'X=1\n');
    expect(await ops.dirtyFiles(worktree)).toEqual(['configuração/.env']);
    git(worktree, 'add', '--force', 'configuração/.env');
    git(worktree, 'commit', '--quiet', '-m', 'x');
    expect(await ops.changedFiles(await ops.headSha(worktree))).toEqual(['configuração/.env']);
  });

  it('pushes only the agent branch', async () => {
    await writeFile(join(worktree, 'feature.ts'), 'export {};\n');
    git(worktree, 'add', 'feature.ts');
    git(worktree, 'commit', '--quiet', '-m', 'feat: x');
    const sha = await ops.headSha(worktree);
    // The branch moves after verification; the verified commit is what gets pushed.
    await writeFile(join(worktree, 'later.ts'), 'export {};\n');
    git(worktree, 'add', 'later.ts');
    git(worktree, 'commit', '--quiet', '-m', 'feat: later');
    await ops.push(sha, branch);
    expect(remoteBranches(fixture.remote).sort()).toEqual([branch, 'main'].sort());
    expect(git(fixture.remote, 'rev-parse', branch).trim()).toBe(sha);
  });

  it('refuses to push or branch on the base branch', async () => {
    await expect(ops.push('a'.repeat(40), 'main')).rejects.toThrow(/base branch/);
    await expect(ops.push('HEAD', branch)).rejects.toThrow(/not a full commit id/);
    await expect(ops.createWorktree(join(fixture.root, 'x'), 'main')).rejects.toThrow(/base branch/);
  });

  it('creates a detached verification worktree at an exact commit', async () => {
    const sha = git(fixture.clone, 'rev-parse', 'HEAD').trim();
    const path = join(fixture.root, 'verify');
    await ops.createVerificationWorktree(path, sha);
    expect(git(path, 'rev-parse', 'HEAD').trim()).toBe(sha);
    expect(git(path, 'branch', '--show-current').trim()).toBe('');
  });

  it('evidence comes from the given commit, not from wherever the branch is now', async () => {
    await writeFile(join(worktree, 'a.ts'), 'export {};\n');
    git(worktree, 'add', 'a.ts');
    git(worktree, 'commit', '--quiet', '-m', 'a');
    const sha = await ops.headSha(worktree);
    await writeFile(join(worktree, '.env'), 'X=1\n');
    git(worktree, 'add', '--force', '.env');
    git(worktree, 'commit', '--quiet', '-m', 'sneaky');
    expect(await ops.commitsAhead(sha)).toBe(1);
    expect(await ops.changedFiles(sha)).toEqual(['a.ts']);
    await expect(ops.changedFiles('HEAD')).rejects.toThrow(/not a full commit id/);
  });

  it('never runs hooks the agent planted in the shared repository', async () => {
    const hooks = join(git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(), 'hooks');
    const marker = join(fixture.root, 'hook-ran');
    for (const hook of ['post-checkout', 'pre-push', 'reference-transaction']) {
      await writeFile(join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      await chmod(join(hooks, hook), 0o755);
    }
    await writeFile(join(worktree, 'feature.ts'), 'export {};\n');
    git(worktree, 'add', 'feature.ts');
    git(worktree, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'feat: x');
    const sha = await ops.headSha(worktree);

    await ops.createVerificationWorktree(join(fixture.root, 'verify'), sha);
    await ops.push(sha, branch);
    expect(existsSync(marker)).toBe(false);
  });

  it('pushes to the URL recorded at fetch, even if the agent rewrites the remote', async () => {
    const decoy = join(fixture.root, 'decoy.git');
    git(fixture.root, 'init', '--quiet', '--bare', decoy);
    git(worktree, 'remote', 'set-url', 'origin', decoy);
    git(worktree, 'remote', 'set-url', '--push', 'origin', decoy);
    await ops.push(await ops.headSha(worktree), branch);
    expect(remoteBranches(fixture.remote)).toContain(branch);
    expect(remoteBranches(decoy)).toEqual([]);
  });

  it('detects and restores changes to the shared git config', async () => {
    const snapshot = await ops.snapshotConfig();
    expect(await ops.configChanged(snapshot)).toBe(false);
    git(worktree, 'config', 'core.fsmonitor', 'touch /tmp/pwned');
    expect(await ops.configChanged(snapshot)).toBe(true);
    await ops.restoreConfig(snapshot);
    expect(await ops.configChanged(snapshot)).toBe(false);
    expect(await readFile(snapshot.file, 'utf8')).not.toContain('fsmonitor');
  });

  it('removes the worktree', async () => {
    await ops.removeWorktree(worktree);
    expect(existsSync(worktree)).toBe(false);
  });
});
