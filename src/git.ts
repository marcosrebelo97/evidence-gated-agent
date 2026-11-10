import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from './exec.js';
import { hostIsolation, type Isolation, type Mount } from './isolation.js';
import { sandboxEnv } from './sandbox.js';

/** What fetch() records before the agent runs. Every later step receives it explicitly. */
export interface Baseline {
  /** SHA of the remote base branch: all comparisons use it, never a ref. */
  base: string;
  /** Where the remote pushes to, after insteadOf rewriting. */
  pushUrls: string[];
}

export interface GitOps {
  /** Updates the remote base branch and records the baseline. */
  fetch(): Promise<Baseline>;
  /**
   * Creates the agent's workspace: a new, independent repository holding only the base
   * commit, on a fresh branch. It shares nothing with the main clone (no hooks, config,
   * refs or object store), so nothing the agent does in it reaches the orchestrator.
   */
  createWorkspace(path: string, branch: string, base: string): Promise<void>;
  /** Deletes a workspace or verification directory. No git runs inside it. */
  removeWorkspace(path: string): Promise<void>;
  /**
   * Brings the agent's HEAD into the main clone, under a private ref, and returns its SHA.
   * From here on, the evidence, the verification and the push all use this SHA.
   * No git of the orchestrator's runs inside the workspace: the new commits come out as a
   * bundle, written by git running with the agent's isolation.
   */
  collect(workspace: string, id: string, base: string): Promise<string>;
  /**
   * Deletes the private ref of a finished run. Its SHA stays in the ledger and the evidence;
   * the objects of a rejected commit (one that touched .env, say) become prunable.
   */
  dropCandidate(id: string): Promise<void>;
  /** Commits in `commit` that are not in `base`. */
  commitsAhead(base: string, commit: string): Promise<number>;
  /** Files changed by `commit` relative to `base` (renames as delete + add). */
  changedFiles(base: string, commit: string): Promise<string[]>;
  /** Uncommitted or untracked files left in the workspace. Runs with the agent's isolation. */
  dirtyFiles(workspace: string): Promise<string[]>;
  /** A new repository with only `commit` checked out: what the gates verify is exactly what gets pushed. */
  createVerification(path: string, commit: string): Promise<void>;
  /**
   * Pushes an exact commit to the agent branch, by remote name, after checking that its push
   * URLs are still those of the baseline. Never forced, never to the base.
   */
  push(commit: string, branch: string, baseline: Baseline): Promise<void>;
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

/** Commits of history copied into the agent's repository and into the verification. */
const WORKSPACE_HISTORY = 50;

function assertSha(commit: string): void {
  if (!FULL_SHA.test(commit)) throw new Error(`not a full commit id: ${commit}`);
}

/** NUL-separated output (-z): paths come raw, never quoted or escaped. */
function nulSeparated(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
}

/** A bundle is the agent's new commits: far below this, or something is wrong. */
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;

/**
 * The pack inside a v2 bundle, after checking its header: exactly one ref, HEAD, at `head`.
 * Prerequisites (`-<sha>`) are checked by index-pack, which needs them to complete the pack.
 */
export function packOfBundle(bundle: Buffer, head: string): Buffer {
  const end = bundle.indexOf('\n\n');
  if (end === -1 || end > 1024 * 1024) throw new Error('not a git bundle: no header');
  const [signature, ...lines] = bundle.subarray(0, end).toString('utf8').split('\n');
  if (signature !== '# v2 git bundle') throw new Error(`unsupported bundle: ${JSON.stringify(signature)}`);
  const refs = lines.filter((line) => !line.startsWith('-'));
  if (refs.length !== 1 || refs[0] !== `${head} HEAD`) {
    throw new Error(`the agent bundle must hold exactly HEAD at ${head}, not ${JSON.stringify(refs)}`);
  }
  const pack = bundle.subarray(end + 2);
  if (pack.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('not a git bundle: no pack');
  return pack;
}

/** Private namespace in the main clone for commits collected from agent workspaces. */
export const CANDIDATE_REFS = 'refs/evidence-gated-agent';

/**
 * `isolation` runs every git command inside a directory the agent wrote (its workspace). The
 * main clone and the verification repository are the orchestrator's: those run on the host.
 */
export function createGit(exec: Exec, settings: GitSettings, isolation: Isolation = hostIsolation(exec)): GitOps {
  const baseRef = `refs/remotes/${settings.remote}/${settings.baseBranch}`;

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
  /** The environment for git on content the agent wrote: no user or system git config either. */
  // GIT_NO_REPLACE_OBJECTS: a refs/replace/* the agent wrote must not make one object pass for another.
  const untrustedEnv = (home: string) =>
    sandboxEnv({
      remote: settings.remote,
      home,
      extra: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    });
  /** A throwaway HOME too: a filter planted in the agent's config must not reach the user's dotfiles. */
  const withThrowawayHome = async <T>(fn: (home: string) => Promise<T>): Promise<T> => {
    const home = await mkdtemp(join(tmpdir(), 'ega-git-home-'));
    try {
      return await fn(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
  /** Git inside the agent's workspace, with the agent's isolation and no network. */
  const inWorkspace = async (workspace: string, args: string[], extraMounts: Mount[] = []): Promise<string> => {
    // A .git file ("gitdir: <main clone>/.git") would point this git at another repository.
    const dotGit = await lstat(join(workspace, '.git')).catch(() => undefined);
    if (!dotGit?.isDirectory()) throw new Error("the agent repository's .git is not a directory");
    return withThrowawayHome(async (home) => {
      const result = await isolation.exec('git', [...SAFE_GIT, ...args], {
        cwd: workspace,
        timeoutMs: GIT_TIMEOUT_MS,
        env: untrustedEnv(home),
        inheritEnv: false,
        killGroupOnExit: true,
        mounts: [{ path: workspace, writable: true }, { path: home, writable: true }, ...extraMounts],
        network: 'none',
      });
      if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
      return result.stdout;
    });
  };
  /**
   * Whether `commit` is the base or one of its ancestors in the main clone. Only then is a HEAD
   * collected without a bundle: any other commit the main clone happens to have (another
   * branch, a local commit of the user's) must come from the agent's own objects.
   */
  const isInBaseHistory = async (commit: string, base: string): Promise<boolean> => {
    const result = await exec('git', [...SAFE_GIT, 'merge-base', '--is-ancestor', commit, base], {
      cwd: settings.repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    return result.code === 0;
  };
  /**
   * Stores the bundle's objects in the main clone with `index-pack --strict`, which runs fsck on
   * every object. `git fetch <bundle>` does not, whatever transfer.fsckObjects says (git < 2.47).
   */
  const indexBundle = async (bundle: string, head: string): Promise<void> => {
    const info = await lstat(bundle);
    if (!info.isFile()) throw new Error('the agent bundle is not a regular file');
    if (info.size > MAX_BUNDLE_BYTES) throw new Error(`the agent bundle is larger than ${MAX_BUNDLE_BYTES} bytes`);
    const pack = packOfBundle(await readFile(bundle), head);
    const args = ['index-pack', '--strict', '--fix-thin', '--stdin'];
    const result = await exec('git', [...SAFE_GIT, ...args], {
      cwd: settings.repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      input: pack,
    });
    if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
  };
  /** Push URLs of the remote, after any insteadOf rewriting: exactly where a push would go. */
  const pushUrlsNow = async (): Promise<string[]> =>
    (await inRepo(['remote', 'get-url', '--push', '--all', settings.remote])).split('\n').filter(Boolean);

  /**
   * A new repository at `path` with `commit` fetched from the main clone, `depth` commits deep.
   * Nothing of the agent's is in it yet.
   */
  const freshRepository = async (path: string, commit: string, depth: number): Promise<void> => {
    await rm(path, { recursive: true, force: true });
    // --template=: none of the user's template hooks end up in a repository the agent works in.
    await run(settings.repoPath, ['init', '--quiet', '--template=', path]);
    await run(path, [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      `--depth=${depth}`,
      settings.repoPath,
      commit,
    ]);
  };

  return {
    async fetch() {
      await inRepo(['fetch', '--quiet', settings.remote, settings.baseBranch]);
      const base = (await inRepo(['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
      return { base, pushUrls: await pushUrlsNow() };
    },

    async createWorkspace(path, branch, base) {
      if (branch === settings.baseBranch) throw new Error('refusing to use the base branch as agent branch');
      assertSha(base);
      // Recent history only: enough for the agent to follow the commit style, without copying the
      // whole repository on every run.
      await freshRepository(path, base, WORKSPACE_HISTORY);
      // The playbook diffs against <remote>/<base>; inside the workspace it is a plain local ref.
      await run(path, ['update-ref', baseRef, base]);
      await run(path, ['checkout', '--quiet', '-b', branch, base]);
    },

    async removeWorkspace(path) {
      await rm(path, { recursive: true, force: true });
    },

    async collect(workspace, id, base) {
      assertSha(base);
      const ref = `${CANDIDATE_REFS}/${id}`;
      const head = (await inWorkspace(workspace, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      assertSha(head);

      if (!(await isInBaseHistory(head, base))) {
        // The bundle goes to a directory of its own, outside the workspace, created now.
        const outDir = `${workspace}.out`;
        const bundle = join(outDir, 'head.bundle');
        await rm(outDir, { recursive: true, force: true });
        await mkdir(outDir, { mode: 0o700 });
        try {
          await inWorkspace(workspace, ['bundle', 'create', '--quiet', '--version=2', bundle, 'HEAD', `^${base}`], [
            { path: outDir, writable: true },
          ]);
          await indexBundle(bundle, head);
        } finally {
          await rm(outDir, { recursive: true, force: true });
        }
      }
      // No new commit (or HEAD moved back into the base's history) needs no transfer.
      await inRepo(['update-ref', ref, head]);

      const collected = (await inRepo(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
      if (collected !== head) throw new Error(`collected ${collected}, but the agent's HEAD is ${head}`);
      return collected;
    },

    async dropCandidate(id) {
      await inRepo(['update-ref', '-d', `${CANDIDATE_REFS}/${id}`]);
    },

    async commitsAhead(base, commit) {
      assertSha(base);
      assertSha(commit);
      return Number.parseInt((await inRepo(['rev-list', '--count', `${base}..${commit}`])).trim(), 10);
    },

    async changedFiles(base, commit) {
      assertSha(base);
      assertSha(commit);
      // --no-renames: a rename shows as delete + add, so the source path of a moved secret is still checked.
      return nulSeparated(await inRepo(['diff', '--name-only', '-z', '--no-renames', `${base}...${commit}`]));
    },

    async dirtyFiles(workspace) {
      // The workspace is the agent's: its config can run filters. Same environment as the agent, nothing more.
      const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'];
      const output = await inWorkspace(workspace, args);
      return nulSeparated(output).map((entry) => entry.slice(3));
    },

    async createVerification(path, commit) {
      assertSha(commit);
      // Same history depth as the agent had: a gate that looks at HEAD~1 or a commit range
      // must see what the agent saw, or a correct commit would be rejected.
      await freshRepository(path, commit, WORKSPACE_HISTORY);
      // The commit's .gitattributes could select a filter from the user's git config (git-lfs, with
      // its credentials): check out unprivileged and without that config.
      // It is the orchestrator's own new repository, so it runs on the host, with that environment.
      await withThrowawayHome((home) => run(path, ['checkout', '--quiet', '--detach', commit], untrustedEnv(home)));
    },

    async push(commit, branch, { pushUrls }) {
      if (branch === settings.baseBranch) throw new Error('refusing to push to the base branch');
      assertSha(commit);
      // Only where the remote pointed before the agent ran. If its URLs (or an insteadOf rule in the
      // user's config) changed during the run, something rewrote the configuration: refuse.
      const now = await pushUrlsNow();
      if (now.join('\n') !== pushUrls.join('\n')) {
        throw new Error(`push URLs of "${settings.remote}" changed during the run; refusing to push`);
      }
      // By remote name: git rewrites the configured URL once, exactly as get-url reported it.
      // Pushing to the already rewritten URL would apply the insteadOf rules a second time.
      await inRepo(['push', '--quiet', '--no-verify', settings.remote, `${commit}:refs/heads/${branch}`]);
    },
  };
}
