import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
    expect(await ops.commitsAhead(worktree)).toBe(0);
    expect(await ops.dirtyFiles(worktree)).toEqual([]);
    expect(await ops.changedFiles(worktree)).toEqual([]);
  });

  it('sees uncommitted work as dirty, and committed work as ahead', async () => {
    await writeFile(join(worktree, 'feature.ts'), 'export {};\n');
    expect(await ops.dirtyFiles(worktree)).toEqual(['feature.ts']);

    git(worktree, 'add', 'feature.ts');
    git(worktree, 'commit', '--quiet', '-m', 'feat: x');
    expect(await ops.commitsAhead(worktree)).toBe(1);
    expect(await ops.dirtyFiles(worktree)).toEqual([]);
    expect(await ops.changedFiles(worktree)).toEqual(['feature.ts']);
  });

  it('pushes only the agent branch', async () => {
    await writeFile(join(worktree, 'feature.ts'), 'export {};\n');
    git(worktree, 'add', 'feature.ts');
    git(worktree, 'commit', '--quiet', '-m', 'feat: x');
    await ops.push(worktree, branch);
    expect(remoteBranches(fixture.remote).sort()).toEqual([branch, 'main'].sort());
  });

  it('refuses to push or branch on the base branch', async () => {
    await expect(ops.push(worktree, 'main')).rejects.toThrow(/base branch/);
    await expect(ops.createWorktree(join(fixture.root, 'x'), 'main')).rejects.toThrow(/base branch/);
  });

  it('removes the worktree', async () => {
    await ops.removeWorktree(worktree);
    expect(existsSync(worktree)).toBe(false);
  });
});
