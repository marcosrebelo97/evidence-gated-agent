import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun, AgentRunner, AgentStatus } from '../../src/agent/runner.js';
import { parseConfig, type ResolvedConfig } from '../../src/config.js';
import type { GateResult } from '../../src/gates.js';
import type { GitOps } from '../../src/git.js';
import type { Notifier, RunSummary } from '../../src/notify.js';
import type { PipelineDeps } from '../../src/pipeline.js';
import { FileRequestSource } from '../../src/source.js';

export const APPROVAL = { approvedBy: 'lead', approvedAt: '2026-01-10T12:00:00Z' };

export interface WorkspaceState {
  commitsAhead: number;
  dirtyFiles: string[];
  changedFiles: string[];
}

export class FakeGit implements GitOps {
  readonly calls: string[] = [];
  readonly pushed: string[] = [];
  readonly pushedCommits: string[] = [];
  static readonly SHA = 'a'.repeat(40);
  static readonly BASE = 'b'.repeat(40);
  state: WorkspaceState = { commitsAhead: 0, dirtyFiles: [], changedFiles: [] };
  failOn?: keyof GitOps;

  private check(op: keyof GitOps, detail = ''): void {
    this.calls.push(detail ? `${op} ${detail}` : op);
    if (this.failOn === op) throw new Error(`${op} exploded`);
  }

  async fetch() {
    this.check('fetch');
    return FakeGit.BASE;
  }
  async createWorkspace(_path: string, branch: string) {
    this.check('createWorkspace', branch);
  }
  async removeWorkspace(path: string) {
    this.check('removeWorkspace', path.split('/').pop());
  }
  async collect(_workspace: string, id: string) {
    this.check('collect', id);
    return this.state.commitsAhead > 0 ? FakeGit.SHA : FakeGit.BASE;
  }
  async commitsAhead() {
    this.check('commitsAhead');
    return this.state.commitsAhead;
  }
  async dirtyFiles() {
    this.check('dirtyFiles');
    return this.state.dirtyFiles;
  }
  async changedFiles() {
    this.check('changedFiles');
    return this.state.changedFiles;
  }
  async createVerification(_path: string, commit: string) {
    this.check('createVerification', commit.slice(0, 7));
  }
  async push(commit: string, branch: string) {
    this.check('push', branch);
    this.pushed.push(branch);
    this.pushedCommits.push(commit);
  }
}

/** Behaves like an agent: declares a status and changes the workspace state. */
export class FakeAgent implements AgentRunner {
  readonly prompts: string[] = [];
  declared: AgentStatus = 'implemented';
  report = 'relatório';
  effect: Partial<WorkspaceState> = { commitsAhead: 1, changedFiles: ['src/feature.ts'] };

  constructor(private readonly git: FakeGit) {}

  readonly homes: (string | undefined)[] = [];

  async run({ prompt, home }: { prompt: string; home?: string | undefined }): Promise<AgentRun> {
    this.prompts.push(prompt);
    this.homes.push(home);
    this.git.state = { ...this.git.state, ...this.effect };
    return {
      status: this.declared,
      report: this.report,
      exitCode: 0,
      timedOut: false,
      durationMs: 9_000,
      costUsd: 0.25,
      rawOutput: '{}',
      rawStderr: '',
    };
  }
}

export class CollectingNotifier implements Notifier {
  readonly sent: RunSummary[] = [];
  fail = false;
  async notify(summary: RunSummary) {
    if (this.fail) throw new Error('telegram down');
    this.sent.push(summary);
  }
}

export const gate = (name: string, passed = true): GateResult => ({
  name,
  passed,
  exitCode: passed ? 0 : 1,
  timedOut: false,
  durationMs: 5,
  outputTail: passed ? '' : 'FAIL',
});

export interface Harness {
  root: string;
  config: ResolvedConfig;
  git: FakeGit;
  agent: FakeAgent;
  notifier: CollectingNotifier;
  gates: GateResult[];
  setup: GateResult[];
  gateRuns: number;
  logs: string[];
  deps: PipelineDeps;
  addRequest(request: Record<string, unknown>, file?: string): Promise<void>;
}

export async function createHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ega-pipeline-'));
  const inboxDir = join(root, 'inbox');
  await mkdir(inboxDir, { recursive: true });
  const config = parseConfig(
    {
      repoPath: join(root, 'repo'),
      inboxDir,
      workDir: join(root, 'work'),
      agent: {},
      gates: [{ name: 'tests', command: 'npm', args: ['test'] }],
      ...overrides,
    },
    root,
  );

  const git = new FakeGit();
  const agent = new FakeAgent(git);
  const notifier = new CollectingNotifier();
  let clock = Date.parse('2026-01-10T12:00:00Z');

  const harness: Harness = {
    root,
    config,
    git,
    agent,
    notifier,
    gates: [gate('tests'), gate('typecheck')],
    setup: [],
    gateRuns: 0,
    logs: [],
    deps: undefined as unknown as PipelineDeps,
    async addRequest(request, file) {
      const id = String(request.id);
      await writeFile(join(inboxDir, file ?? `${id}.json`), JSON.stringify(request));
    },
  };

  harness.deps = {
    config,
    source: new FileRequestSource(inboxDir),
    git,
    agent,
    runSetup: async () => harness.setup,
    runGates: async () => {
      harness.gateRuns++;
      return harness.gates;
    },
    notifier,
    playbook: 'branch={{BRANCH}} status={{STATUS_FILE}}\n<solicitacao>\n{{REQUEST}}\n</solicitacao>\n{{ATTACHMENTS}}',
    now: () => new Date((clock += 60_000)),
    log: (message) => harness.logs.push(message),
  };
  return harness;
}
