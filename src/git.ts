import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Exec } from './exec.js';

/** The shared repository config at a point in time, to detect (and undo) tampering. */
export interface ConfigSnapshot {
  file: string;
  content: string;
}

export interface GitOps {
  /** Updates the remote base branch and records the push URL before any agent runs. */
  fetch(): Promise<void>;
  /** Creates a disposable worktree on a fresh branch from the remote base. The main clone is never checked out. */
  createWorktree(path: string, branch: string): Promise<void>;
  removeWorktree(path: string): Promise<void>;
  headSha(worktree: string): Promise<string>;
  /** Commits in `commit` that are not in the base. */
  commitsAhead(commit: string): Promise<number>;
  /** Files changed by `commit` relative to the base (renames as delete + add). */
  changedFiles(commit: string): Promise<string[]>;
  /** Uncommitted or untracked files left in the worktree. */
  dirtyFiles(worktree: string): Promise<string[]>;
  /** A detached worktree at an exact commit: what the gates verify is exactly what gets pushed. */
  createVerificationWorktree(path: string, commit: string): Promise<void>;
  /** Pushes an exact commit to the agent branch, to the URL recorded by fetch(). Never forced, never to the base. */
  push(commit: string, branch: string): Promise<void>;
  snapshotConfig(): Promise<ConfigSnapshot>;
  configChanged(snapshot: ConfigSnapshot): Promise<boolean>;
  restoreConfig(snapshot: ConfigSnapshot): Promise<void>;
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

/**
 * Worktrees share hooks and config with the main clone, and the agent can write to both.
 * Every git command the orchestrator runs (with its full environment) ignores hooks and
 * fsmonitor, so nothing the agent planted executes on the orchestrator's side.
 */
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

const FULL_SHA = /^[0-9a-f]{40,64}$/;

function assertSha(commit: string): void {
  if (!FULL_SHA.test(commit)) throw new Error(`not a full commit id: ${commit}`);
}

/** NUL-separated output (-z): paths come raw, never quoted or escaped. */
function nulSeparated(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
}

export function createGit(exec: Exec, settings: GitSettings): GitOps {
  const baseRef = `${settings.remote}/${settings.baseBranch}`;
  let pushUrl: string | undefined;

  const git = async (cwd: string, args: string[]): Promise<string> => {
    const result = await exec('git', [...SAFE_GIT, ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
    return result.stdout;
  };
  const inRepo = (args: string[]) => git(settings.repoPath, args);

  const configFile = async (): Promise<string> => {
    const dir = (await inRepo(['rev-parse', '--git-common-dir'])).trim();
    return join(isAbsolute(dir) ? dir : join(settings.repoPath, dir), 'config');
  };

  return {
    async fetch() {
      await inRepo(['fetch', '--quiet', settings.remote, settings.baseBranch]);
      pushUrl = (await inRepo(['remote', 'get-url', '--push', settings.remote])).trim();
    },

    async createWorktree(path, branch) {
      if (branch === settings.baseBranch) throw new Error('refusing to use the base branch as agent branch');
      // -B: a retried request starts again from the current base instead of reusing an old attempt.
      await inRepo(['worktree', 'add', '--quiet', '-B', branch, path, baseRef]);
    },

    async removeWorktree(path) {
      await inRepo(['worktree', 'remove', '--force', path]);
      await inRepo(['worktree', 'prune']);
    },

    async headSha(worktree) {
      return (await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    },

    async commitsAhead(commit) {
      assertSha(commit);
      return Number.parseInt((await inRepo(['rev-list', '--count', `${baseRef}..${commit}`])).trim(), 10);
    },

    async changedFiles(commit) {
      assertSha(commit);
      // --no-renames: a rename shows as delete + add, so the source path of a moved secret is still checked.
      return nulSeparated(await inRepo(['diff', '--name-only', '-z', '--no-renames', `${baseRef}...${commit}`]));
    },

    async dirtyFiles(worktree) {
      const output = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
      return nulSeparated(output).map((entry) => entry.slice(3));
    },

    async createVerificationWorktree(path, commit) {
      assertSha(commit);
      await inRepo(['worktree', 'add', '--quiet', '--detach', path, commit]);
    },

    async push(commit, branch) {
      if (branch === settings.baseBranch) throw new Error('refusing to push to the base branch');
      assertSha(commit);
      if (!pushUrl) throw new Error('push URL unknown: fetch() must run before any agent');
      // The URL recorded before the agent ran: a remote rewritten by the agent has no effect.
      await inRepo(['push', '--quiet', '--no-verify', pushUrl, `${commit}:refs/heads/${branch}`]);
    },

    async snapshotConfig() {
      const file = await configFile();
      return { file, content: await readFile(file, 'utf8') };
    },

    async configChanged(snapshot) {
      return (await readFile(snapshot.file, 'utf8').catch(() => '')) !== snapshot.content;
    },

    async restoreConfig(snapshot) {
      await writeFile(snapshot.file, snapshot.content, 'utf8');
    },
  };
}
