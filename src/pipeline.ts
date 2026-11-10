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
  runSetup: (worktree: string) => Promise<GateResult[]>;
  runGates: (worktree: string) => Promise<GateResult[]>;
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
    worktree: (id: string) => join(workDir, 'worktrees', id),
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

interface Execution {
  outcome: Outcome;
  reasons: string[];
  report: string;
  costUsd?: number | undefined;
  keepWorktree: boolean;
}

async function execute(
  loaded: LoadedRequest,
  branch: string,
  runDir: string,
  deps: PipelineDeps,
): Promise<Execution> {
  const { config, git } = deps;
  const { request } = loaded;
  const worktree = runnerPaths(config.workDir).worktree(request.id);

  const attachments = await prepareRunDir(runDir, loaded);

  await git.fetch();
  // A previous attempt may have kept its worktree for inspection; start clean.
  await git.removeWorktree(worktree).catch(() => undefined);
  await rm(worktree, { recursive: true, force: true });
  await git.createWorktree(worktree, branch);

  const setup = await deps.runSetup(worktree);
  await writeJson(join(runDir, 'setup.json'), setup);
  const brokenSetup = setup.filter((step) => !step.passed);
  if (brokenSetup.length > 0) {
    return {
      outcome: 'failed',
      reasons: brokenSetup.map((step) => `setup "${step.name}" failed (exit ${step.exitCode})`),
      report: '',
      keepWorktree: true,
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
  const run = await deps.agent.run({ worktree, runDir, prompt });
  await writeFile(join(runDir, 'agent-output.json'), run.rawOutput, 'utf8');
  deps.log(`[${request.id}] agent declared ${run.status} in ${(run.durationMs / 1000).toFixed(0)}s`);

  const changed = await git.changedFiles(worktree);
  const preliminary = {
    declared: run.status,
    contractViolation: run.contractViolation,
    commitsAhead: await git.commitsAhead(worktree),
    dirtyFiles: await git.dirtyFiles(worktree),
    forbiddenTouched: findForbidden(changed, config.forbiddenPaths),
  };
  const evidence: Evidence = {
    ...preliminary,
    gates: gatesAreWorthRunning(preliminary) ? await deps.runGates(worktree) : [],
  };
  const decision = decide(evidence);
  await writeJson(join(runDir, 'evidence.json'), { ...evidence, changedFiles: changed, decision });

  const base = { report: run.report, costUsd: run.costUsd };
  if (!decision.publish) {
    // A blocked run has no code worth inspecting; rejected and failed runs keep theirs.
    return { ...base, outcome: decision.outcome, reasons: decision.reasons, keepWorktree: decision.outcome !== 'blocked' };
  }
  if (!config.push) return { ...base, outcome: 'ready', reasons: [], keepWorktree: true };

  await git.push(worktree, branch);
  return { ...base, outcome: 'published', reasons: [], keepWorktree: false };
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
    result = { outcome: 'failed', reasons: [`orchestrator error: ${(error as Error).message}`], report: '', keepWorktree: true };
  }

  if (!result.keepWorktree) {
    await deps.git.removeWorktree(paths.worktree(request.id)).catch((error: Error) => {
      deps.log(`[${request.id}] could not remove worktree: ${error.message}`);
    });
  }

  const finishedAt = deps.now();
  await ledger.finish(request.id, { status: result.outcome, reasons: result.reasons, costUsd: result.costUsd }, finishedAt);

  const summary: RunSummary = {
    id: request.id,
    title: request.title,
    requestedBy: request.requestedBy,
    outcome: result.outcome,
    branch,
    reasons: result.reasons,
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
}

/** One pass: take the lock, recover interrupted runs, then process new approved requests one at a time. */
export async function pollOnce(deps: PipelineDeps): Promise<PollReport> {
  const paths = runnerPaths(deps.config.workDir);
  const report: PollReport = { locked: false, recovered: [], processed: [], alreadyHandled: [], pending: [], invalid: [] };

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
      if (ledger.has(loaded.request.id)) {
        report.alreadyHandled.push(loaded.request.id);
        continue;
      }
      report.processed.push(await processRequest(loaded, deps, ledger));
    }
  } finally {
    await lock.release();
  }
  return report;
}
