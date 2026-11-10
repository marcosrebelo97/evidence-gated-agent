import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Exec } from '../exec.js';
import { sandboxEnv } from '../sandbox.js';

export const STATUS_FILE = 'STATUS';
export const REPORT_FILE = 'REPORT.md';

export const AGENT_STATUSES = ['implemented', 'blocked', 'failed'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface AgentRun {
  status: AgentStatus;
  report: string;
  /** Why the run was forced to "failed" regardless of what the agent wrote. */
  contractViolation?: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  costUsd?: number;
  numTurns?: number;
  rawOutput: string;
  rawStderr: string;
}

export interface AgentRunInput {
  worktree: string;
  runDir: string;
  prompt: string;
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRun>;
}

export interface AgentRunnerSettings {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  /** Remote whose push is disabled inside the agent's environment. */
  remote: string;
  passEnv?: readonly string[];
  gitAuthor?: { name: string; email: string } | undefined;
}

/** Subset of `claude -p --output-format json` that the orchestrator records. */
const headlessOutputSchema = z.object({
  is_error: z.boolean().optional(),
  total_cost_usd: z.number().optional(),
  num_turns: z.number().optional(),
});

export function parseHeadlessOutput(stdout: string): z.infer<typeof headlessOutputSchema> {
  try {
    const parsed = headlessOutputSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function parseStatus(raw: string | undefined): AgentStatus | undefined {
  const value = raw?.trim().toLowerCase();
  return AGENT_STATUSES.find((status) => status === value);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Runs the agent headless inside the worktree. The prompt goes through stdin; the run
 * directory is granted with --add-dir so the agent can write the contract files there.
 * Anything outside the contract (crash, timeout, missing or invalid STATUS) becomes "failed".
 */
export function createAgentRunner(exec: Exec, settings: AgentRunnerSettings): AgentRunner {
  return {
    async run({ worktree, runDir, prompt }) {
      const statusPath = join(runDir, STATUS_FILE);
      const reportPath = join(runDir, REPORT_FILE);
      // A retry must never read the contract files of a previous attempt.
      await rm(statusPath, { force: true });
      await rm(reportPath, { force: true });

      const author: Record<string, string> = settings.gitAuthor
        ? {
            GIT_AUTHOR_NAME: settings.gitAuthor.name,
            GIT_AUTHOR_EMAIL: settings.gitAuthor.email,
            GIT_COMMITTER_NAME: settings.gitAuthor.name,
            GIT_COMMITTER_EMAIL: settings.gitAuthor.email,
          }
        : {};

      const result = await exec(settings.command, [...settings.args, '--add-dir', runDir], {
        cwd: worktree,
        input: prompt,
        timeoutMs: settings.timeoutMs,
        env: sandboxEnv({ remote: settings.remote, passEnv: settings.passEnv ?? [], extra: author }),
        inheritEnv: false,
        killGroupOnExit: true,
      });

      const meta = parseHeadlessOutput(result.stdout);
      const rawStatus = await readOptional(statusPath);
      const declared = parseStatus(rawStatus);
      const report = (await readOptional(reportPath)) ?? '';

      let contractViolation: string | undefined;
      if (result.timedOut) contractViolation = `agent timed out after ${settings.timeoutMs} ms`;
      else if (result.code !== 0) contractViolation = `agent exited with code ${result.code}`;
      else if (meta.is_error) contractViolation = 'agent session ended with an error';
      else if (rawStatus === undefined) contractViolation = `agent did not write ${STATUS_FILE}`;
      else if (declared === undefined) contractViolation = `invalid ${STATUS_FILE} content: ${JSON.stringify(rawStatus.trim().slice(0, 50))}`;

      return {
        status: contractViolation ? 'failed' : (declared as AgentStatus),
        report,
        ...(contractViolation ? { contractViolation } : {}),
        exitCode: result.code,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        ...(meta.total_cost_usd !== undefined ? { costUsd: meta.total_cost_usd } : {}),
        ...(meta.num_turns !== undefined ? { numTurns: meta.num_turns } : {}),
        rawOutput: result.stdout,
        rawStderr: result.stderr,
      };
    },
  };
}
