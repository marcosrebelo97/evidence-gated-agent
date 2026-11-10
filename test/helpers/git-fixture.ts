import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY },
  });
}

export interface GitFixture {
  root: string;
  remote: string;
  clone: string;
}

/** A bare "remote" with one commit on main, and a main clone of it. */
export async function createGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), 'ega-git-'));
  const remote = join(root, 'remote.git');
  const clone = join(root, 'clone');
  git(root, 'init', '--quiet', '--bare', '-b', 'main', remote);
  git(root, 'init', '--quiet', '-b', 'main', clone);
  git(clone, 'remote', 'add', 'origin', remote);
  await writeFile(join(clone, 'README.md'), '# target\n');
  git(clone, 'add', 'README.md');
  git(clone, 'commit', '--quiet', '-m', 'initial');
  git(clone, 'push', '--quiet', 'origin', 'main');
  return { root, remote, clone };
}

export function remoteBranches(remote: string): string[] {
  return git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean);
}
