import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { slugify } from './scope.js';

const commandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(10 * 60_000),
  /** Environment variables this command needs beyond the sandbox baseline (e.g. a registry token). */
  passEnv: z.array(z.string().min(1)).default([]),
});

export type CommandSpec = z.infer<typeof commandSchema>;

const notifierSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('console') }),
  // The bot token is read from TELEGRAM_BOT_TOKEN, never from the config file.
  z.object({ type: z.literal('telegram'), chatId: z.string().min(1) }),
]);

export const configSchema = z.object({
  /** Main clone of the target repository. The agent never works in it: each run gets its own repository. */
  repoPath: z.string().min(1),
  remote: z.string().min(1).default('origin'),
  baseBranch: z.string().min(1).default('main'),
  branchPrefix: z
    .string()
    .regex(/^[a-z0-9][a-z0-9/_-]*\/$/, 'branchPrefix must end with "/"')
    .default('agent/'),
  /** Where approved requests are read from (file source). */
  inboxDir: z.string().min(1),
  /**
   * Ledger, lock, run artifacts, agent repositories and their HOMEs. Defaults to a per-repository folder under
   * ~/.local/state. Never inside repoPath or this orchestrator: Claude Code reads CLAUDE.md
   * from parent directories, so the agent would pick up the wrong instructions.
   */
  workDir: z.string().min(1).optional(),
  /** Glob patterns the agent must never touch. Without "/", they match the file name anywhere. */
  forbiddenPaths: z.array(z.string().min(1)).default(['.env', '.env.*']),
  /**
   * Allowed, but flagged to the reviewer: files that define how the gates behave
   * (scripts, test config) or how agents work. The agent can legitimately change them,
   * and that is exactly why a human should look.
   */
  attentionPaths: z
    .array(z.string().min(1))
    .default([
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      '*.config.*',
      'tsconfig*.json',
      '.husky/**',
      '.github/**',
      '.claude/**',
      'CLAUDE.md',
    ]),
  /**
   * Give the agent, the setup and the gates a fresh, empty HOME per run. On by default:
   * otherwise they read and can write the dotfiles of the user running the poll.
   * Claude Code then authenticates through ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
   * (created with `claude setup-token`), which are passed to the agent automatically.
   */
  isolateHome: z.boolean().default(true),
  /** Runs in the fresh workspace before the agent (e.g. dependency install). */
  setup: z.array(commandSchema).default([]),
  agent: z.object({
    command: z.string().min(1).default('claude'),
    args: z
      .array(z.string())
      .default(['-p', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config']),
    timeoutMs: z.number().int().positive().default(30 * 60_000),
    /**
     * Variables the agent needs beyond the sandbox baseline. With isolateHome, ANTHROPIC_API_KEY
     * and CLAUDE_CODE_OAUTH_TOKEN are added automatically; other providers (Bedrock, Vertex) go here.
     */
    passEnv: z.array(z.string().min(1)).default([]),
    playbook: z.string().min(1).optional(),
    /** Author of the agent's commits. Required in practice: an isolated HOME has no git identity. */
    gitAuthor: z
      .object({ name: z.string().min(1), email: z.string().min(3) })
      .default({ name: 'evidence-gated-agent', email: 'evidence-gated-agent@users.noreply.invalid' }),
  }),
  /** Re-run by the orchestrator after the agent finishes. Publication requires all of them green. */
  gates: z.array(commandSchema).min(1, 'at least one gate is required: nothing is published without evidence'),
  push: z.boolean().default(true),
  notifier: notifierSchema.default({ type: 'console' }),
});

export type AgentConfig = z.infer<typeof configSchema>;

/** Config with every path made absolute. */
export type ResolvedConfig = Omit<AgentConfig, 'workDir'> & {
  workDir: string;
  agent: AgentConfig['agent'] & { playbook: string };
};

export const ORCHESTRATOR_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_PLAYBOOK = join(ORCHESTRATOR_ROOT, 'playbook', 'agent-playbook.md');

export function defaultWorkDir(repoPath: string, home = homedir()): string {
  const id = createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
  return join(home, '.local', 'state', 'evidence-gated-agent', `${slugify(basename(repoPath))}-${id}`);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function parseConfig(raw: unknown, baseDir: string): ResolvedConfig {
  const config = configSchema.parse(raw);
  const repoPath = resolve(baseDir, config.repoPath);
  const workDir = config.workDir ? resolve(baseDir, config.workDir) : defaultWorkDir(repoPath);

  if (isInside(repoPath, workDir)) {
    throw new Error(`workDir (${workDir}) must be outside repoPath: agent repositories cannot live inside the repository`);
  }
  if (isInside(ORCHESTRATOR_ROOT, workDir)) {
    throw new Error(
      `workDir (${workDir}) must be outside the orchestrator: the agent would load the orchestrator's CLAUDE.md`,
    );
  }

  return {
    ...config,
    repoPath,
    inboxDir: resolve(baseDir, config.inboxDir),
    workDir,
    agent: {
      ...config.agent,
      playbook: config.agent.playbook ? resolve(baseDir, config.agent.playbook) : DEFAULT_PLAYBOOK,
    },
  };
}

export async function loadConfig(file: string): Promise<ResolvedConfig> {
  const absolute = resolve(file);
  const raw: unknown = JSON.parse(await readFile(absolute, 'utf8'));
  return parseConfig(raw, dirname(absolute));
}
