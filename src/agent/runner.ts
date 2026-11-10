import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
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
  /** The agent's own repository: the only place it works in. */
  workspace: string;
  /**
   * The only directory the agent may write outside its workspace: STATUS and REPORT.md.
   * The orchestrator's own audit files never live in it.
   */
  contractDir: string;
  /** Directories the agent needs to read (the attachments). */
  readDirs?: readonly string[];
  prompt: string;
  /** The agent's own HOME, when isolated. */
  home?: string | undefined;
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
  gitAuthor: { name: string; email: string };
}

/** Subset of `claude -p --output-format json` that the orchestrator records. */
const headlessOutputSchema = z.object({
  is_error: z.boolean().optional(),
  /** The final message; on an error, why (e.g. an invalid API key). */
  result: z.string().optional(),
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

function lastLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

/** The contract is a few lines of text; anything bigger is not the agent following it. */
export const MAX_CONTRACT_BYTES = 256 * 1024;

type ContractFile = { content: string } | { error: string } | undefined;

/**
 * Reads a file the agent wrote. O_NOFOLLOW: a symlink planted in its place (REPORT.md ->
 * ~/.ssh/id_ed25519) is refused instead of followed, so nothing private ends up in the
 * notification. O_NONBLOCK keeps a FIFO from hanging the orchestrator.
 */
async function readContractFile(path: string): Promise<ContractFile> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    return { error: code === 'ELOOP' ? 'is a symbolic link' : `cannot be read (${code ?? 'unknown error'})` };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { error: 'is not a regular file' };
    if (info.size > MAX_CONTRACT_BYTES) return { error: `is larger than ${MAX_CONTRACT_BYTES} bytes` };
    const buffer = Buffer.alloc(MAX_CONTRACT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONTRACT_BYTES) return { error: `is larger than ${MAX_CONTRACT_BYTES} bytes` };
    return { content: buffer.subarray(0, bytesRead).toString('utf8') };
  } finally {
    await handle.close();
  }
}

/**
 * Runs the agent headless inside its workspace. The prompt goes through stdin; only the
 * contract directory (and the attachments, to read) are granted with --add-dir.
 * Anything outside the contract (crash, timeout, missing or invalid STATUS) becomes "failed".
 */
export function createAgentRunner(exec: Exec, settings: AgentRunnerSettings): AgentRunner {
  return {
    async run({ workspace, contractDir, readDirs = [], prompt, home }) {
      const statusPath = join(contractDir, STATUS_FILE);
      const reportPath = join(contractDir, REPORT_FILE);
      await mkdir(contractDir, { recursive: true, mode: 0o700 });
      // A retry must never read the contract files of a previous attempt.
      await rm(statusPath, { force: true });
      await rm(reportPath, { force: true });

      const author: Record<string, string> = {
        GIT_AUTHOR_NAME: settings.gitAuthor.name,
        GIT_AUTHOR_EMAIL: settings.gitAuthor.email,
        GIT_COMMITTER_NAME: settings.gitAuthor.name,
        GIT_COMMITTER_EMAIL: settings.gitAuthor.email,
      };

      const granted = [contractDir, ...readDirs].flatMap((dir) => ['--add-dir', dir]);
      const result = await exec(settings.command, [...settings.args, ...granted], {
        cwd: workspace,
        input: prompt,
        timeoutMs: settings.timeoutMs,
        env: sandboxEnv({
          remote: settings.remote,
          passEnv: settings.passEnv ?? [],
          home,
          extra: author,
        }),
        inheritEnv: false,
        killGroupOnExit: true,
      });

      const meta = parseHeadlessOutput(result.stdout);
      const statusFile = await readContractFile(statusPath);
      const reportFile = await readContractFile(reportPath);
      const rawStatus = statusFile && 'content' in statusFile ? statusFile.content : undefined;
      const declared = parseStatus(rawStatus);
      const report = reportFile && 'content' in reportFile ? reportFile.content : '';
      const unreadable = [
        statusFile && 'error' in statusFile ? `${STATUS_FILE} ${statusFile.error}` : undefined,
        reportFile && 'error' in reportFile ? `${REPORT_FILE} ${reportFile.error}` : undefined,
      ].filter(Boolean);

      let contractViolation: string | undefined;
      // The agent's own words travel with the failure, so the notification says what to fix
      // (an expired token, a missing login) instead of only an exit code.
      const cause = meta.result ?? lastLine(result.stderr);
      const detail = cause ? `: ${cause.slice(0, 300)}` : '';
      if (result.timedOut) contractViolation = `agent timed out after ${settings.timeoutMs} ms`;
      else if (result.code !== 0) contractViolation = `agent exited with code ${result.code}${detail}`;
      else if (meta.is_error) contractViolation = `agent session ended with an error${detail}`;
      else if (unreadable.length > 0) contractViolation = `contract file refused: ${unreadable.join('; ')}`;
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
