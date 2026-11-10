import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { exec, type Exec, type ExecOptions } from '../src/exec.js';
import { CANDIDATE_REFS, createGit, packOfBundle, type Baseline, type GitOps } from '../src/git.js';
import { hostIsolation, type IsolatedExecOptions, type Isolation } from '../src/isolation.js';
import { createGitFixture, git, remoteBranches, type GitFixture } from './helpers/git-fixture.js';

let fixture: GitFixture;
let ops: GitOps;
let workspace: string;
let baseline: Baseline;
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
  baseline = await ops.fetch();
  base = baseline.base;
  await ops.createWorkspace(workspace, branch, base);
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
    await ops.createWorkspace(workspace, branch, base);
    expect(existsSync(join(workspace, 'old.ts'))).toBe(false);
    expect(git(workspace, 'rev-parse', 'HEAD').trim()).toBe(base);
  });

  it('reports no evidence before the agent works', async () => {
    const head = await ops.collect(workspace, 'REQ-1', base);
    expect(head).toBe(base);
    expect(await ops.commitsAhead(base, head)).toBe(0);
    expect(await ops.dirtyFiles(workspace)).toEqual([]);
    expect(await ops.changedFiles(base, head)).toEqual([]);
  });

  it('sees uncommitted work as dirty, and committed work as ahead', async () => {
    await writeFile(join(workspace, 'feature.ts'), 'export {};\n');
    expect(await ops.dirtyFiles(workspace)).toEqual(['feature.ts']);

    commit(workspace, 'feature.ts');
    const head = await ops.collect(workspace, 'REQ-1', base);
    expect(git(fixture.clone, 'rev-parse', `${CANDIDATE_REFS}/REQ-1`).trim()).toBe(head);
    expect(await ops.commitsAhead(base, head)).toBe(1);
    expect(await ops.dirtyFiles(workspace)).toEqual([]);
    expect(await ops.changedFiles(base, head)).toEqual(['feature.ts']);
  });

  it('reports both sides of a rename, so a moved secret cannot hide', async () => {
    await commitFile(fixture.clone, '.env.production', 'SECRET=1\n');
    git(fixture.clone, 'push', '--quiet', 'origin', 'main');
    baseline = await ops.fetch();
    base = baseline.base;
    await ops.createWorkspace(workspace, branch, base);

    git(workspace, 'mv', '.env.production', 'prod-settings.txt');
    git(workspace, 'commit', '--quiet', '-m', 'innocent rename');
    const head = await ops.collect(workspace, 'REQ-1', base);
    expect((await ops.changedFiles(base, head)).sort()).toEqual(['.env.production', 'prod-settings.txt']);
  });

  it('returns non-ASCII paths unquoted', async () => {
    await mkdir(join(workspace, 'configuração'));
    await writeFile(join(workspace, 'configuração', '.env'), 'X=1\n');
    expect(await ops.dirtyFiles(workspace)).toEqual(['configuração/.env']);
    commit(workspace, 'configuração/.env');
    expect(await ops.changedFiles(base, await ops.collect(workspace, 'REQ-1', base))).toEqual(['configuração/.env']);
  });

  it('drops the private ref of a finished run', async () => {
    await commitFile(workspace, '.env', 'SECRET=1\n');
    await ops.collect(workspace, 'REQ-1', base);
    await ops.dropCandidate('REQ-1');
    expect(git(fixture.clone, 'for-each-ref', CANDIDATE_REFS).trim()).toBe('');
  });

  it('compares against the recorded base, so moving the base ref cannot hide a commit', async () => {
    const sneaky = await commitFile(workspace, '.env', 'SECRET=1\n');
    await commitFile(workspace, 'a.ts');
    git(workspace, 'update-ref', 'refs/remotes/origin/main', sneaky);

    const head = await ops.collect(workspace, 'REQ-1', base);
    expect(await ops.commitsAhead(base, head)).toBe(2);
    expect((await ops.changedFiles(base, head)).sort()).toEqual(['.env', 'a.ts']);
  });

  it('evidence comes from the collected SHA, not from wherever the branch is now', async () => {
    await commitFile(workspace, 'a.ts');
    const sha = await ops.collect(workspace, 'REQ-1', base);
    await commitFile(workspace, '.env', 'X=1\n');
    expect(await ops.commitsAhead(base, sha)).toBe(1);
    expect(await ops.changedFiles(base, sha)).toEqual(['a.ts']);
    await expect(ops.changedFiles(base, 'HEAD')).rejects.toThrow(/not a full commit id/);
  });
});

describe('the agent cannot reach the orchestrator through git', () => {
  it('never runs hooks the agent planted in its workspace', async () => {
    const marker = join(fixture.root, 'hook-ran');
    await mkdir(join(workspace, '.git', 'hooks'), { recursive: true });
    for (const hook of ['post-checkout', 'pre-push', 'reference-transaction', 'post-merge']) {
      await writeFile(join(workspace, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      await chmod(join(workspace, '.git', 'hooks', hook), 0o755);
    }
    await writeFile(join(workspace, 'feature.ts'), 'export {};\n');
    git(workspace, 'add', 'feature.ts');
    git(workspace, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'feat: x');

    const sha = await ops.collect(workspace, 'REQ-1', base);
    await ops.dirtyFiles(workspace);
    await ops.createVerification(join(fixture.root, 'verify'), sha);
    await ops.push(sha, branch, baseline);
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

    expect(await ops.collect(workspace, 'REQ-1', base)).toBe(sha);
    await ops.dirtyFiles(workspace);
    await ops.push(sha, branch, baseline);

    expect(remoteBranches(fixture.remote)).toContain(branch);
    expect(remoteBranches(decoy)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(join(fixture.clone, '.git', 'config'), 'utf8')).toBe(before);
  });

  it('a filter the agent planted runs unprivileged, with a throwaway HOME', async () => {
    const marker = join(fixture.root, 'filter-home');
    await writeFile(join(workspace, '.gitattributes'), '*.txt filter=x\n');
    await commitFile(workspace, 'data.txt', 'aaaa\n');
    git(workspace, 'add', '.gitattributes');
    git(workspace, 'commit', '--quiet', '-m', 'attributes');
    git(workspace, 'config', 'filter.x.clean', `sh -c 'echo "$HOME" >> "${marker}"; cat'`);
    // Same size, new content: git has to run the clean filter to know whether it changed.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await writeFile(join(workspace, 'data.txt'), 'bbbb\n');

    expect(await ops.dirtyFiles(workspace)).toEqual(['data.txt']);
    const homes = (await readFile(marker, 'utf8')).trim().split('\n');
    expect(homes.length).toBeGreaterThan(0);
    for (const home of homes) {
      expect(home).toContain('ega-git-home-');
      expect(existsSync(home)).toBe(false);
    }
  });

  it("never copies the user's template hooks into a repository the agent works in", async () => {
    const template = join(fixture.root, 'template');
    await mkdir(join(template, 'hooks'), { recursive: true });
    await writeFile(join(template, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    await chmod(join(template, 'hooks', 'pre-commit'), 0o755);
    const globalConfig = join(fixture.root, 'user.gitconfig');
    await writeFile(globalConfig, `[init]\n\ttemplateDir = ${template}\n`);

    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      await ops.createWorkspace(workspace, branch, base);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
    expect(existsSync(join(workspace, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('runs git inside the workspace only through the isolation, without network or user config', async () => {
    const onHost: ExecOptions[] = [];
    const spy: Exec = (command, args, options) => {
      onHost.push(options);
      return exec(command, args, options);
    };
    const isolated: { args: readonly string[]; options: IsolatedExecOptions }[] = [];
    const host = hostIsolation(exec);
    const isolation: Isolation = {
      mode: 'container',
      exec: (command, args, options) => {
        isolated.push({ args, options });
        return host.exec(command, args, options);
      },
    };
    const spied = createGit(spy, settings(), isolation);
    await commitFile(workspace, 'feature.ts');
    await spied.collect(workspace, 'REQ-1', base);
    await spied.dirtyFiles(workspace);

    expect(onHost.filter((options) => options.cwd.startsWith(workspace))).toEqual([]);
    expect(isolated.map(({ args }) => args.find((arg) => ['rev-parse', 'bundle', 'status'].includes(arg)))).toEqual([
      'rev-parse',
      'bundle',
      'status',
    ]);
    for (const { options } of isolated) {
      expect(options).toMatchObject({ cwd: workspace, network: 'none', inheritEnv: false });
      expect(options.mounts[0]).toEqual({ path: workspace, writable: true });
      // Nor the user's git config: a filter defined there (e.g. git-lfs) would act with the user's credentials.
      expect(options.env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    }
    // The bundle is the only thing written outside the workspace, in a directory of its own.
    expect(isolated[1]?.options.mounts.at(-1)).toEqual({ path: `${workspace}.out`, writable: true });
    expect(existsSync(`${workspace}.out`)).toBe(false);
  });

  it('refuses a bundle the agent replaced with a symlink', async () => {
    await commitFile(workspace, 'feature.ts');
    const host = hostIsolation(exec);
    const tampering: Isolation = {
      mode: 'none',
      exec: async (command, args, options) => {
        const result = await host.exec(command, args, options);
        if (args.includes('bundle')) {
          const bundle = join(`${workspace}.out`, 'head.bundle');
          await rename(bundle, `${bundle}.real`);
          await symlink(`${bundle}.real`, bundle);
        }
        return result;
      },
    };
    await expect(createGit(exec, settings(), tampering).collect(workspace, 'REQ-1', base)).rejects.toThrow(
      'the agent bundle is not a regular file',
    );
    expect(git(fixture.clone, 'for-each-ref', CANDIDATE_REFS).trim()).toBe('');
  });

  it('ignores refs/replace: HEAD cannot pass for a commit the main clone has elsewhere', async () => {
    // A commit the main clone has and the workspace never received (another branch, say).
    git(fixture.clone, 'checkout', '--quiet', '-b', 'other');
    const elsewhere = await commitFile(fixture.clone, 'other.ts');
    git(fixture.clone, 'checkout', '--quiet', 'main');
    const own = await commitFile(workspace, 'feature.ts');
    git(workspace, 'update-ref', `refs/replace/${elsewhere}`, own);
    await writeFile(join(workspace, '.git', 'HEAD'), `${elsewhere}\n`);

    await expect(ops.collect(workspace, 'REQ-1', base)).rejects.toThrow(/rev-parse/);
    expect(git(fixture.clone, 'for-each-ref', CANDIDATE_REFS).trim()).toBe('');
  });

  it('runs fsck on every object of the bundle: a malformed commit never enters the main clone', async () => {
    const tree = git(workspace, 'rev-parse', 'HEAD^{tree}').trim();
    const body = `tree ${tree}\nparent ${base}\nauthor no-email 1 +0000\ncommitter x <x@y> 1 +0000\n\nbad\n`;
    await writeFile(join(fixture.root, 'bad-commit'), body);
    const bad = git(workspace, 'hash-object', '-t', 'commit', '-w', '--literally', join(fixture.root, 'bad-commit')).trim();
    git(workspace, 'update-ref', 'HEAD', bad);

    await expect(ops.collect(workspace, 'REQ-1', base)).rejects.toThrow(/fsck error/);
    expect(() => git(fixture.clone, 'cat-file', '-e', bad)).toThrow();
  });

  it('refuses a workspace whose .git points at another repository', async () => {
    await commitFile(workspace, 'feature.ts');
    await rm(join(workspace, '.git'), { recursive: true, force: true });
    await writeFile(join(workspace, '.git'), `gitdir: ${join(fixture.clone, '.git')}\n`);
    await expect(ops.collect(workspace, 'REQ-1', base)).rejects.toThrow('.git is not a directory');
    await expect(ops.dirtyFiles(workspace)).rejects.toThrow('.git is not a directory');
  });

  it('collects a HEAD moved back into the base history without a bundle', async () => {
    git(fixture.clone, 'commit', '--quiet', '--allow-empty', '-m', 'second');
    git(fixture.clone, 'push', '--quiet', 'origin', 'main');
    const newBase = (await ops.fetch()).base;
    await ops.createWorkspace(workspace, branch, newBase);
    git(workspace, 'reset', '--quiet', '--hard', 'HEAD~1');
    const head = await ops.collect(workspace, 'REQ-1', newBase);
    expect(head).toBe(base);
    expect(await ops.commitsAhead(newBase, head)).toBe(0);
  });
});

describe('verification and push (real git)', () => {
  it('creates an independent repository with only the exact commit checked out', async () => {
    const sha = await commitFile(workspace, 'feature.ts');
    await ops.collect(workspace, 'REQ-1', base);
    const path = join(fixture.root, 'verify');
    await ops.createVerification(path, sha);
    expect(git(path, 'rev-parse', 'HEAD').trim()).toBe(sha);
    expect(git(path, 'branch', '--show-current').trim()).toBe('');
    expect(git(path, 'remote').trim()).toBe('');
    expect(existsSync(join(path, 'feature.ts'))).toBe(true);
  });

  it('pushes the exact commit, even after the branch moved', async () => {
    await commitFile(workspace, 'feature.ts');
    const sha = await ops.collect(workspace, 'REQ-1', base);
    await commitFile(workspace, 'later.ts');
    await ops.push(sha, branch, baseline);
    expect(remoteBranches(fixture.remote).sort()).toEqual([branch, 'main'].sort());
    expect(git(fixture.remote, 'rev-parse', branch).trim()).toBe(sha);
  });

  it('pushes to every push URL of the remote', async () => {
    const mirror = join(fixture.root, 'mirror.git');
    git(fixture.root, 'init', '--quiet', '--bare', mirror);
    git(fixture.clone, 'remote', 'set-url', '--add', '--push', 'origin', fixture.remote);
    git(fixture.clone, 'remote', 'set-url', '--add', '--push', 'origin', mirror);
    baseline = await ops.fetch();
    const sha = await commitFile(workspace, 'feature.ts');
    await ops.collect(workspace, 'REQ-1', base);
    await ops.push(sha, branch, baseline);
    expect(remoteBranches(fixture.remote)).toContain(branch);
    expect(remoteBranches(mirror)).toEqual([branch]);
  });

  it('copies only recent history into the workspace and into the verification', async () => {
    for (let i = 0; i < 60; i++) git(fixture.clone, 'commit', '--quiet', '--allow-empty', '-m', `history ${i}`);
    git(fixture.clone, 'push', '--quiet', 'origin', 'main');
    baseline = await ops.fetch();
    base = baseline.base;
    await ops.createWorkspace(workspace, branch, base);
    expect(Number(git(workspace, 'rev-list', '--count', 'HEAD').trim())).toBe(50);

    // A shallow workspace still hands over its commit, and the main clone still diffs it in full.
    const sha = await commitFile(workspace, 'feature.ts');
    expect(await ops.collect(workspace, 'REQ-1', base)).toBe(sha);
    expect(await ops.changedFiles(base, sha)).toEqual(['feature.ts']);

    const path = join(fixture.root, 'verify');
    await ops.createVerification(path, sha);
    expect(git(path, 'rev-list', '--count', 'HEAD').trim()).toBe('50');
    expect(git(path, 'rev-parse', 'HEAD~1').trim()).toBe(base);
  });

  it('refuses to push when the push URLs changed after fetch', async () => {
    const decoy = join(fixture.root, 'decoy.git');
    git(fixture.root, 'init', '--quiet', '--bare', decoy);
    const sha = await commitFile(workspace, 'feature.ts');
    await ops.collect(workspace, 'REQ-1', base);
    // Same effect as a pushInsteadOf rule planted in the user's ~/.gitconfig.
    git(fixture.clone, 'config', `url.${decoy}.pushInsteadOf`, fixture.remote);
    await expect(ops.push(sha, branch, baseline)).rejects.toThrow(/push URLs of "origin" changed/);
    expect(remoteBranches(decoy)).toEqual([]);
    expect(remoteBranches(fixture.remote)).toEqual(['main']);
  });

  it('applies insteadOf rules once, so the push lands where get-url said it would', async () => {
    const real = join(fixture.root, 'real.git');
    const other = join(fixture.root, 'other.git');
    git(fixture.root, 'init', '--quiet', '--bare', real);
    git(fixture.root, 'init', '--quiet', '--bare', other);
    // "fetch over one URL, push over another", plus a rule that matches the rewritten URL.
    git(fixture.clone, 'remote', 'set-url', 'origin', 'alias:x');
    git(fixture.clone, 'config', `url.${real}.pushInsteadOf`, 'alias:x');
    git(fixture.clone, 'config', `url.${other}.insteadOf`, real);
    git(fixture.clone, 'config', `url.${fixture.remote}.insteadOf`, 'alias:x');
    baseline = await ops.fetch();
    expect(baseline.pushUrls).toEqual([real]);

    const sha = await commitFile(workspace, 'feature.ts');
    await ops.collect(workspace, 'REQ-1', base);
    await ops.push(sha, branch, baseline);
    expect(remoteBranches(real)).toEqual([branch]);
    expect(remoteBranches(other)).toEqual([]);
  });

  it('refuses to push or branch on the base branch', async () => {
    await expect(ops.push('a'.repeat(40), 'main', baseline)).rejects.toThrow(/base branch/);
    await expect(ops.push('HEAD', branch, baseline)).rejects.toThrow(/not a full commit id/);
    await expect(ops.createWorkspace(join(fixture.root, 'x'), 'main', base)).rejects.toThrow(/base branch/);
  });

  it('removes the workspace', async () => {
    await ops.removeWorkspace(workspace);
    expect(existsSync(workspace)).toBe(false);
  });
});

describe('packOfBundle', () => {
  const head = 'a'.repeat(40);
  const bundle = (header: string) => Buffer.concat([Buffer.from(`${header}\n\n`), Buffer.from('PACK\x00\x00\x00\x02')]);

  it('returns the pack of a bundle holding only HEAD at the expected commit', () => {
    const pack = packOfBundle(bundle(`# v2 git bundle\n-${'b'.repeat(40)} base\n${head} HEAD`), head);
    expect(pack.subarray(0, 4).toString()).toBe('PACK');
  });

  it('refuses other refs, another HEAD and other formats', () => {
    expect(() => packOfBundle(bundle(`# v2 git bundle\n${head} HEAD\n${head} refs/heads/main`), head)).toThrow(
      /exactly HEAD/,
    );
    expect(() => packOfBundle(bundle(`# v2 git bundle\n${'c'.repeat(40)} HEAD`), head)).toThrow(/exactly HEAD/);
    expect(() => packOfBundle(bundle(`# v3 git bundle\n@object-format=sha1\n${head} HEAD`), head)).toThrow(
      /unsupported bundle/,
    );
    expect(() => packOfBundle(Buffer.from('no header'), head)).toThrow(/no header/);
  });
});
