import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from './exec.js';
import { sandboxEnv } from './sandbox.js';

export interface GitOps {
  /** Updates the remote base branch and records its SHA: every later comparison uses that SHA. */
  fetch(): Promise<string>;
  /**
   * Creates the agent's workspace: a new, independent repository holding only the base
   * commit, on a fresh branch. It shares nothing with the main clone (no hooks, config,
   * refs or object store), so nothing the agent does in it reaches the orchestrator.
   */
  createWorkspace(path: string, branch: string): Promise<void>;
  /** Deletes a workspace or verification directory. No git runs inside it. */
  removeWorkspace(path: string): Promise<void>;
  /**
   * Brings the agent's HEAD into the main clone, under a private ref, and returns its SHA.
   * From here on, the evidence, the verification and the push all use this SHA.
   */
  collect(workspace: string, id: string): Promise<string>;
  /** Commits in `commit` that are not in the recorded base. */
  commitsAhead(commit: string): Promise<number>;
  /** Files changed by `commit` relative to the recorded base (renames as delete + add). */
  changedFiles(commit: string): Promise<string[]>;
  /** Uncommitted or untracked files left in the workspace. Runs with the agent's privileges. */
  dirtyFiles(workspace: string): Promise<string[]>;
  /** A new repository with only `commit` checked out: what the gates verify is exactly what gets pushed. */
  createVerification(path: string, commit: string): Promise<void>;
  /**
   * Pushes an exact commit to the agent branch, at every push URL recorded by fetch().
   * Never forced, never to the base.
   */
  push(commit: string, branch: string): Promise<void>;
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
 * Applied to every git command the orchestrator runs. The main clone is never written by
 * the agent, but the orchestrator still never runs a hook or an fsmonitor command.
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

/** Private namespace in the main clone for commits collected from agent workspaces. */
export const CANDIDATE_REFS = 'refs/evidence-gated-agent';

export function createGit(exec: Exec, settings: GitSettings): GitOps {
  const baseRef = `refs/remotes/${settings.remote}/${settings.baseBranch}`;
  let baseSha: string | undefined;
  let pushUrls: string[] | undefined;

  const run = async (cwd: string, args: string[], env?: Record<string, string>): Promise<string> => {
    const result = await exec('git', [...SAFE_GIT, ...args], {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      ...(env ? { env, inheritEnv: false, killGroupOnExit: true } : {}),
    });
    if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
    return result.stdout;
  };
  const inRepo = (args: string[]) => run(settings.repoPath, args);
  /** For git inside a directory whose content the agent wrote: no user or system git config either. */
  const untrusted = async <T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> => {
    // A throwaway HOME too: a filter planted in the agent's config must not reach the user's dotfiles.
    const home = await mkdtemp(join(tmpdir(), 'ega-git-home-'));
    try {
      return await fn(
        sandboxEnv({ remote: settings.remote, home, extra: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
  /** Push URLs of the remote, after any insteadOf rewriting: exactly where a push would go. */
  const pushUrlsNow = async (): Promise<string[]> =>
    (await inRepo(['remote', 'get-url', '--push', '--all', settings.remote])).split('\n').filter(Boolean);
  const base = (): string => {
    if (!baseSha) throw new Error('base unknown: fetch() must run first');
    return baseSha;
  };

  /** A new repository at `path` with `commit` fetched from the main clone. Nothing of the agent's is in it yet. */
  const freshRepository = async (path: string, commit: string): Promise<void> => {
    await rm(path, { recursive: true, force: true });
    // --template=: none of the user's template hooks end up in a repository the agent works in.
    await run(settings.repoPath, ['init', '--quiet', '--template=', path]);
    await run(path, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', settings.repoPath, commit]);
  };

  return {
    async fetch() {
      await inRepo(['fetch', '--quiet', settings.remote, settings.baseBranch]);
      baseSha = (await inRepo(['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
      pushUrls = await pushUrlsNow();
      return baseSha;
    },

    async createWorkspace(path, branch) {
      if (branch === settings.baseBranch) throw new Error('refusing to use the base branch as agent branch');
      const commit = base();
      await freshRepository(path, commit);
      // The playbook diffs against <remote>/<base>; inside the workspace it is a plain local ref.
      await run(path, ['update-ref', baseRef, commit]);
      await run(path, ['checkout', '--quiet', '-b', branch, commit]);
    },

    async removeWorkspace(path) {
      await rm(path, { recursive: true, force: true });
    },

    async collect(workspace, id) {
      const ref = `${CANDIDATE_REFS}/${id}`;
      // upload-pack is the side of git built to serve untrusted repositories: the workspace's
      // config, hooks and attributes are not executed by this fetch.
      await inRepo(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', workspace, `+HEAD:${ref}`]);
      return (await inRepo(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    },

    async commitsAhead(commit) {
      assertSha(commit);
      return Number.parseInt((await inRepo(['rev-list', '--count', `${base()}..${commit}`])).trim(), 10);
    },

    async changedFiles(commit) {
      assertSha(commit);
      // --no-renames: a rename shows as delete + add, so the source path of a moved secret is still checked.
      return nulSeparated(await inRepo(['diff', '--name-only', '-z', '--no-renames', `${base()}...${commit}`]));
    },

    async dirtyFiles(workspace) {
      // The workspace is the agent's: its config can run filters. Same environment as the agent, nothing more.
      const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'];
      const output = await untrusted((env) => run(workspace, args, env));
      return nulSeparated(output).map((entry) => entry.slice(3));
    },

    async createVerification(path, commit) {
      assertSha(commit);
      await freshRepository(path, commit);
      // The commit's .gitattributes could select a filter from the user's git config (git-lfs, with
      // its credentials): check out unprivileged and without that config.
      await untrusted((env) => run(path, ['checkout', '--quiet', '--detach', commit], env));
    },

    async push(commit, branch) {
      if (branch === settings.baseBranch) throw new Error('refusing to push to the base branch');
      assertSha(commit);
      if (!pushUrls) throw new Error('push URLs unknown: fetch() must run first');
      // Only where the remote pointed before the agent ran. If its URLs (or an insteadOf rule in the
      // user's config) changed during the run, something rewrote the configuration: refuse.
      const now = await pushUrlsNow();
      if (now.join('\n') !== pushUrls.join('\n')) {
        throw new Error(`push URLs of "${settings.remote}" changed during the run; refusing to push`);
      }
      for (const url of pushUrls) {
        await inRepo(['push', '--quiet', '--no-verify', url, `${commit}:refs/heads/${branch}`]);
      }
    },
  };
}
