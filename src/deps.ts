import { readFile } from 'node:fs/promises';
import { createAgentRunner } from './agent/runner.js';
import type { ResolvedConfig } from './config.js';
import { exec } from './exec.js';
import { runCommands } from './gates.js';
import { createGit } from './git.js';
import { hostIsolation } from './isolation.js';
import { ConsoleNotifier, TelegramNotifier, type Notifier } from './notify.js';
import type { PipelineDeps } from './pipeline.js';
import { FileRequestSource } from './source.js';

function createNotifier(config: ResolvedConfig): Notifier {
  if (config.notifier.type === 'console') return new ConsoleNotifier();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('notifier "telegram" requires the TELEGRAM_BOT_TOKEN environment variable');
  return new TelegramNotifier(token, config.notifier.chatId);
}

/**
 * How Claude Code authenticates without a ~/.claude of its own. Passed to the agent only when
 * its HOME is isolated: with the user's HOME, a stored subscription login must keep winning
 * over an API key that happens to be in the environment.
 */
export const CLAUDE_AUTH_VARIABLES = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function agentPassEnv(config: ResolvedConfig): string[] {
  const extra = config.isolateHome ? CLAUDE_AUTH_VARIABLES : [];
  return [...new Set([...config.agent.passEnv, ...extra])];
}

/** Wires the real implementations. Tests build PipelineDeps by hand instead. */
export async function createDefaultDeps(config: ResolvedConfig): Promise<PipelineDeps> {
  const host = hostIsolation(exec);
  const isolation = host;
  return {
    config,
    source: new FileRequestSource(config.inboxDir),
    git: createGit(exec, config, isolation),
    agent: createAgentRunner(isolation, { ...config.agent, passEnv: agentPassEnv(config), remote: config.remote }),
    // The trusted setup runs on the untouched base, before the agent: on the host, with git transports.
    runSetup: (dir, { trusted, home }) =>
      runCommands(trusted ? host : isolation, config.setup, dir, {
        remote: config.remote,
        network: 'setup',
        allowGitTransport: trusted,
        home,
      }),
    runGates: (dir, { home }) => runCommands(isolation, config.gates, dir, { remote: config.remote, network: 'gates', home }),
    notifier: createNotifier(config),
    playbook: await readFile(config.agent.playbook, 'utf8'),
    now: () => new Date(),
    log: (message) => console.error(`${new Date().toISOString()} ${message}`),
  };
}
