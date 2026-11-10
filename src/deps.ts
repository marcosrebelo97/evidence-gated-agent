import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createAgentRunner } from './agent/runner.js';
import type { ResolvedConfig } from './config.js';
import { exec } from './exec.js';
import { runCommands } from './gates.js';
import { createGit } from './git.js';
import { ConsoleNotifier, TelegramNotifier, type Notifier } from './notify.js';
import { runnerPaths, type PipelineDeps } from './pipeline.js';
import { FileRequestSource } from './source.js';

function createNotifier(config: ResolvedConfig): Notifier {
  if (config.notifier.type === 'console') return new ConsoleNotifier();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('notifier "telegram" requires the TELEGRAM_BOT_TOKEN environment variable');
  return new TelegramNotifier(token, config.notifier.chatId);
}

/** Variables through which Claude Code authenticates without a ~/.claude of its own. */
export const CLAUDE_AUTH_VARIABLES = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * With an isolated HOME, Claude Code has no stored login. Fail once, at start, with the fix,
 * instead of turning every request into "agent exited with code 1".
 */
export function checkAgentAuth(config: ResolvedConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (!config.isolateHome || basename(config.agent.command) !== 'claude') return;
  const available = CLAUDE_AUTH_VARIABLES.filter((name) => config.agent.passEnv.includes(name) && env[name]);
  if (available.length === 0) {
    throw new Error(
      'isolateHome is on, so Claude Code cannot use a stored login: set ANTHROPIC_API_KEY or ' +
        'CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) and list it in agent.passEnv, ' +
        'or set "isolateHome": false',
    );
  }
}

/** Wires the real implementations. Tests build PipelineDeps by hand instead. */
export async function createDefaultDeps(config: ResolvedConfig): Promise<PipelineDeps> {
  checkAgentAuth(config);
  // Isolated runs share one npm cache: a fresh HOME must not mean downloading everything again.
  const isolated: Record<string, string> = config.isolateHome
    ? { npm_config_cache: runnerPaths(config.workDir).npmCache }
    : {};
  return {
    config,
    source: new FileRequestSource(config.inboxDir),
    git: createGit(exec, config),
    agent: createAgentRunner(exec, { ...config.agent, remote: config.remote, extraEnv: isolated }),
    runSetup: (dir, { trusted, home }) =>
      runCommands(exec, config.setup, dir, {
        remote: config.remote,
        allowGitTransport: trusted,
        home,
        extra: home ? isolated : {},
      }),
    runGates: (dir, { home }) =>
      runCommands(exec, config.gates, dir, { remote: config.remote, home, extra: home ? isolated : {} }),
    notifier: createNotifier(config),
    playbook: await readFile(config.agent.playbook, 'utf8'),
    now: () => new Date(),
    log: (message) => console.error(`${new Date().toISOString()} ${message}`),
  };
}
