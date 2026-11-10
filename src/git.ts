import type { Exec } from './exec.js';

export interface GitOps {
  /** Updates the remote base branch the worktree starts from. */
  fetch(): Promise<void>;
  /** Creates a disposable worktree on a fresh branch from the remote base. The main clone is never checked out. */
  createWorktree(path: string, branch: string): Promise<void>;
  removeWorktree(path: string): Promise<void>;
  commitsAhead(worktree: string): Promise<number>;
  /** Uncommitted or untracked files left in the worktree. */
  dirtyFiles(worktree: string): Promise<string[]>;
  /** Files changed by the branch relative to the base. */
  changedFiles(worktree: string): Promise<string[]>;
  /** Pushes the agent branch. Never forced, never to the base branch. */
  push(worktree: string, branch: string): Promise<void>;
}

export interface GitSettings {
  repoPath: string;
  remote: string;
  baseBranch: string;
}

export class GitError extends Error {
  constructor(args: readonly string[], code: number, stderr: string) {
    super(`git ${args.join(' ')} exited with ${code}: ${stderr.trim().slice(0, 500)}`);
    this.name = 'GitError';
  }
}

const GIT_TIMEOUT_MS = 5 * 60_000;

/** NUL-separated output (-z): paths come raw, never quoted or escaped. */
function nulSeparated(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
}

export function createGit(exec: Exec, settings: GitSettings): GitOps {
  const baseRef = `${settings.remote}/${settings.baseBranch}`;

  const git = async (cwd: string, args: string[]): Promise<string> => {
    const result = await exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
    return result.stdout;
  };

  return {
    async fetch() {
      await git(settings.repoPath, ['fetch', '--quiet', settings.remote, settings.baseBranch]);
    },

    async createWorktree(path, branch) {
      if (branch === settings.baseBranch) throw new Error('refusing to use the base branch as agent branch');
      // -B: a retried request starts again from the current base instead of reusing an old attempt.
      await git(settings.repoPath, ['worktree', 'add', '--quiet', '-B', branch, path, baseRef]);
    },

    async removeWorktree(path) {
      await git(settings.repoPath, ['worktree', 'remove', '--force', path]);
      await git(settings.repoPath, ['worktree', 'prune']);
    },

    async commitsAhead(worktree) {
      const output = await git(worktree, ['rev-list', '--count', `${baseRef}..HEAD`]);
      return Number.parseInt(output.trim(), 10);
    },

    async dirtyFiles(worktree) {
      const output = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
      return nulSeparated(output).map((entry) => entry.slice(3));
    },

    async changedFiles(worktree) {
      // --no-renames: a rename shows as delete + add, so the source path of a moved secret is still checked.
      const output = await git(worktree, ['diff', '--name-only', '-z', '--no-renames', `${baseRef}...HEAD`]);
      return nulSeparated(output);
    },

    async push(worktree, branch) {
      if (branch === settings.baseBranch) throw new Error('refusing to push to the base branch');
      await git(worktree, ['push', '--quiet', settings.remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    },
  };
}
