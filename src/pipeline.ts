import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { buildPrompt } from './agent/prompt.js';
import { REPORT_FILE, STATUS_FILE, type AgentRunner } from './agent/runner.js';
import type { ResolvedConfig } from './config.js';
import { decide, gatesAreWorthRunning, type Evidence, type GateResult } from './gates.js';
import type { GitOps } from './git.js';
import type { Notifier, RunSummary } from './notify.js';
import { branchName, findForbidden } from './scope.js';
import type { LoadedRequest, RequestSource } from './source.js';
import { Ledger, type Outcome } from './state/ledger.js';
import { acquireLock } from './state/lock.js';

export interface PipelineDeps {
  config: ResolvedConfig;
  source: RequestSource;
  git: GitOps;
  agent: AgentRunner;
  /**
   * `trusted`: the workspace holds only the untouched base (before the agent runs), so the
   * setup may use git transports, e.g. for git dependencies. On the agent's commit it may not.
   */
  runSetup: (dir: string, options: { trusted: boolean; home: string | undefined }) => Promise<GateResult[]>;
  runGates: (dir: string, options: { home: string | undefined }) => Promise<GateResult[]>;
  notifier: Notifier;
  playbook: string;
  now: () => Date;
  log: (message: string) => void;
}

export function runnerPaths(workDir: string) {
  return {
    ledger: join(workDir, 'ledger.json'),
    lock: join(workDir, 'poll.lock'),
    /** One directory per attempt, so a retry never overwrites the audit trail of the previous one. */
    runDir: (id: string, startedAt: Date) => join(workDir, 'runs', id, startedAt.toISOString().replace(/[:.]/g, '-')),
    workspace: (id: string) => join(workDir, 'workspaces', id),
    verification: (id: string) => join(workDir, 'workspaces', `${id}.verify`),
    /** The isolated HOME that goes with a workspace or verification directory. */
    home: (dir: string) => `${dir}.home`,
  };
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** Copies attachments into the run dir: the agent only ever sees the audited copies. */
async function prepareRunDir(runDir: string, loaded: LoadedRequest): Promise<string[]> {
  const attachmentsDir = join(runDir, 'attachments');
  await mkdir(attachmentsDir, { recursive: true });
  await writeJson(join(runDir, 'request.json'), loaded.request);
  const copies: string[] = [];
  for (const [index, source] of loaded.attachmentPaths.entries()) {
    const target = join(attachmentsDir, `${index + 1}-${basename(source)}`);
    await copyFile(source, target);
    copies.push(target);
  }
  return copies;
}

/** A new, empty HOME for one run, or undefined when isolation is off. */
async function freshHome(dir: string, deps: PipelineDeps): Promise<string | undefined> {
  if (!deps.config.isolateHome) return undefined;
  const home = runnerPaths(deps.config.workDir).home(dir);
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  return home;
}

/** Deletes a workspace or verification directory together with its HOME. */
async function discard(dir: string, deps: PipelineDeps): Promise<void> {
  await deps.git.removeWorkspace(dir);
  await rm(runnerPaths(deps.config.workDir).home(dir), { recursive: true, force: true });
}

/**
 * Re-runs setup and gates in a new repository holding only the exact commit. Nothing the
 * agent left behind (ignored files, a modified node_modules, its repository config) and
 * nothing the tests do can influence the verdict or reach the main clone.
 */
async function verifyCommit(commit: string, id: string, deps: PipelineDeps): Promise<GateResult[]> {
  const path = runnerPaths(deps.config.workDir).verification(id);
  try {
    await deps.git.createVerification(path, commit);
    const home = await freshHome(path, deps);
    const setup = await deps.runSetup(path, { trusted: false, home });
    const brokenSetup = setup.filter((step) => !step.passed);
    if (brokenSetup.length > 0) return brokenSetup.map((step) => ({ ...step, name: `setup:${step.name}` }));
    return await deps.runGates(path, { home });
  } finally {
    await discard(path, deps).catch((error: Error) => {
      deps.log(`[${id}] could not remove verification directory: ${error.message}`);
    });
  }
}

interface Execution {
  outcome: Outcome;
  reasons: string[];
  report: string;
  costUsd?: number | undefined;
  commit?: string | undefined;
  attention: string[];
  keepWorkspace: boolean;
}

async function execute(
  loaded: LoadedRequest,
  branch: string,
  runDir: string,
  deps: PipelineDeps,
): Promise<Execution> {
  const { config, git } = deps;
  const { request } = loaded;
  const workspace = runnerPaths(config.workDir).workspace(request.id);

  const attachments = await prepareRunDir(runDir, loaded);

  const baseSha = await git.fetch();
  // A previous attempt may have kept its workspace for inspection; this starts clean.
  await git.createWorkspace(workspace, branch);
  const home = await freshHome(workspace, deps);

  // Still only the base here: nothing of the agent's has run yet.
  const setup = await deps.runSetup(workspace, { trusted: true, home });
  await writeJson(join(runDir, 'setup.json'), setup);
  const brokenSetup = setup.filter((step) => !step.passed);
  if (brokenSetup.length > 0) {
    return {
      outcome: 'failed',
      reasons: brokenSetup.map((step) => `setup "${step.name}" failed (exit ${step.exitCode})`),
      report: '',
      attention: [],
      keepWorkspace: true,
    };
  }

  const prompt = buildPrompt({
    template: deps.playbook,
    request,
    branch,
    baseRef: `${config.remote}/${config.baseBranch}`,
    runDir,
    statusFile: join(runDir, STATUS_FILE),
    reportFile: join(runDir, REPORT_FILE),
    attachments,
  });
  await writeFile(join(runDir, 'prompt.md'), prompt, 'utf8');

  deps.log(`[${request.id}] agent started on ${branch}`);
  const run = await deps.agent.run({ workspace, runDir, prompt, home });
  await writeFile(join(runDir, 'agent-output.json'), run.rawOutput, 'utf8');
  await writeFile(join(runDir, 'agent-stderr.log'), run.rawStderr, 'utf8');
  deps.log(`[${request.id}] agent declared ${run.status} in ${(run.durationMs / 1000).toFixed(0)}s`);

  // The agent's HEAD is copied into the main clone once; every check below uses that SHA,
  // compared against the base SHA recorded before the agent ran.
  const head = await git.collect(workspace, request.id);
  const commitsAhead = await git.commitsAhead(head);
  const changed = await git.changedFiles(head);
  const preliminary = {
    declared: run.status,
    contractViolation: run.contractViolation,
    commit: commitsAhead > 0 ? head : undefined,
    commitsAhead,
    dirtyFiles: await git.dirtyFiles(workspace),
    forbiddenTouched: findForbidden(changed, config.forbiddenPaths),
  };
  const evidence: Evidence = {
    ...preliminary,
    gates:
      preliminary.commit && gatesAreWorthRunning(preliminary)
        ? await verifyCommit(preliminary.commit, request.id, deps)
        : [],
  };
  const attention = findForbidden(changed, config.attentionPaths);
  const decision = decide(evidence);
  await writeJson(join(runDir, 'evidence.json'), {
    ...evidence,
    base: baseSha,
    changedFiles: changed,
    attention,
    decision,
  });

  const result = { report: run.report, costUsd: run.costUsd, commit: evidence.commit, attention };
  if (!decision.publish) {
    // A blocked run has no code worth inspecting; rejected and failed runs keep theirs.
    return { ...result, outcome: decision.outcome, reasons: decision.reasons, keepWorkspace: decision.outcome !== 'blocked' };
  }
  if (!config.push) return { ...result, outcome: 'ready', reasons: [], keepWorkspace: true };

  await git.push(evidence.commit as string, branch);
  return { ...result, outcome: 'published', reasons: [], keepWorkspace: false };
}

/**
 * Runs one request end to end. Never throws for request-level problems: every
 * failure ends as a finished ledger entry and a notification.
 */
export async function processRequest(loaded: LoadedRequest, deps: PipelineDeps, ledger: Ledger): Promise<RunSummary> {
  const { request } = loaded;
  const startedAt = deps.now();
  const branch = branchName(deps.config.branchPrefix, request.id, request.title);
  const paths = runnerPaths(deps.config.workDir);
  const runDir = paths.runDir(request.id, startedAt);

  await ledger.start(request.id, branch, startedAt);

  let result: Execution;
  try {
    result = await execute(loaded, branch, runDir, deps);
  } catch (error) {
    result = {
      outcome: 'failed',
      reasons: [`orchestrator error: ${(error as Error).message}`],
      report: '',
      attention: [],
      keepWorkspace: true,
    };
  }

  // Pushed or not, the commit no longer needs a ref in the main clone.
  await deps.git.dropCandidate(request.id).catch(() => undefined);

  if (!result.keepWorkspace) {
    await discard(paths.workspace(request.id), deps).catch((error: Error) => {
      deps.log(`[${request.id}] could not remove workspace: ${error.message}`);
    });
  }

  const finishedAt = deps.now();
  await ledger.finish(
    request.id,
    { status: result.outcome, reasons: result.reasons, costUsd: result.costUsd, commit: result.commit },
    finishedAt,
  );

  const summary: RunSummary = {
    id: request.id,
    title: request.title,
    requestedBy: request.requestedBy,
    outcome: result.outcome,
    branch,
    commit: result.commit,
    reasons: result.reasons,
    attention: result.attention,
    report: result.report,
    costUsd: result.costUsd,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
  await mkdir(runDir, { recursive: true });
  await writeJson(join(runDir, 'summary.json'), summary);

  await deps.notifier.notify(summary).catch((error: Error) => {
    deps.log(`[${request.id}] notification failed: ${error.message}`);
  });
  deps.log(`[${request.id}] finished as ${result.outcome}`);
  return summary;
}

export interface PollReport {
  locked: boolean;
  recovered: string[];
  processed: RunSummary[];
  alreadyHandled: string[];
  pending: string[];
  invalid: { file: string; error: string }[];
  /** Requests whose bookkeeping itself failed (e.g. disk full). Their ledger entry is recovered next poll. */
  errors: { id: string; error: string }[];
}

/** One pass: take the lock, recover interrupted runs, then process new approved requests one at a time. */
export async function pollOnce(deps: PipelineDeps): Promise<PollReport> {
  const paths = runnerPaths(deps.config.workDir);
  const report: PollReport = {
    locked: false,
    recovered: [],
    processed: [],
    alreadyHandled: [],
    pending: [],
    invalid: [],
    errors: [],
  };

  const lock = await acquireLock(paths.lock);
  if (!lock) {
    deps.log('another poll is running; skipping this pass');
    return { ...report, locked: true };
  }

  try {
    // Opened only after the lock: no other instance can be writing it now.
    const ledger = await Ledger.open(paths.ledger);
    report.recovered = await ledger.recoverInterrupted(deps.now());

    const scan = await deps.source.scan();
    report.pending = scan.pending;
    report.invalid = scan.invalid;
    for (const invalid of scan.invalid) deps.log(`invalid request file ${invalid.file}: ${invalid.error}`);

    for (const loaded of scan.approved) {
      const { id } = loaded.request;
      if (ledger.has(id)) {
        report.alreadyHandled.push(id);
        continue;
      }
      try {
        report.processed.push(await processRequest(loaded, deps, ledger));
      } catch (error) {
        // One request's bookkeeping failure must not stop the others.
        report.errors.push({ id, error: (error as Error).message });
        deps.log(`[${id}] bookkeeping failed: ${(error as Error).message}`);
      }
    }
  } finally {
    await lock.release();
  }
  return report;
}
