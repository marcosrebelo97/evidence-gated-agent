import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
  /** Main clone of the target repository. Only worktrees are created from it. */
  repoPath: z.string().min(1),
  remote: z.string().min(1).default('origin'),
  baseBranch: z.string().min(1).default('main'),
  branchPrefix: z
    .string()
    .regex(/^[a-z0-9][a-z0-9/_-]*\/$/, 'branchPrefix must end with "/"')
    .default('agent/'),
  /** Where approved requests are read from (file source). */
  inboxDir: z.string().min(1),
  /** Ledger, lock, run artifacts and worktrees. Keep it outside repoPath. */
  workDir: z.string().min(1).default('.agent-runner'),
  /** Glob patterns the agent must never touch. Without "/", they match the file name anywhere. */
  forbiddenPaths: z.array(z.string().min(1)).default(['.env', '.env.*']),
  /**
   * Allowed, but flagged to the reviewer: files that define how the gates behave
   * (scripts, test config) or how agents work. The agent can legitimately change them,
   * and that is exactly why a human should look.
   */
  attentionPaths: z
    .array(z.string().min(1))
    .default(['package.json', '*.config.*', 'tsconfig*.json', '.github/**', '.claude/**', 'CLAUDE.md']),
  /** Runs in the fresh worktree before the agent (e.g. dependency install). */
  setup: z.array(commandSchema).default([]),
  agent: z.object({
    command: z.string().min(1).default('claude'),
    args: z.array(z.string()).default(['-p', '--output-format', 'json']),
    timeoutMs: z.number().int().positive().default(30 * 60_000),
    /** Variables the agent needs beyond the sandbox baseline, e.g. ANTHROPIC_API_KEY. */
    passEnv: z.array(z.string().min(1)).default([]),
    playbook: z.string().min(1).optional(),
    gitAuthor: z.object({ name: z.string().min(1), email: z.string().min(3) }).optional(),
  }),
  /** Re-run by the orchestrator after the agent finishes. Publication requires all of them green. */
  gates: z.array(commandSchema).min(1, 'at least one gate is required: nothing is published without evidence'),
  push: z.boolean().default(true),
  notifier: notifierSchema.default({ type: 'console' }),
});

export type AgentConfig = z.infer<typeof configSchema>;

/** Config with every path made absolute. */
export type ResolvedConfig = AgentConfig & { agent: AgentConfig['agent'] & { playbook: string } };

export const DEFAULT_PLAYBOOK = fileURLToPath(new URL('../playbook/agent-playbook.md', import.meta.url));

export function parseConfig(raw: unknown, baseDir: string): ResolvedConfig {
  const config = configSchema.parse(raw);
  return {
    ...config,
    repoPath: resolve(baseDir, config.repoPath),
    inboxDir: resolve(baseDir, config.inboxDir),
    workDir: resolve(baseDir, config.workDir),
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
