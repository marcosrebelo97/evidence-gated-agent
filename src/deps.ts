import { readFile } from 'node:fs/promises';
import { createAgentRunner } from './agent/runner.js';
import type { ResolvedConfig } from './config.js';
import { exec } from './exec.js';
import { runCommands } from './gates.js';
import { createGit } from './git.js';
import { ConsoleNotifier, TelegramNotifier, type Notifier } from './notify.js';
import type { PipelineDeps } from './pipeline.js';
import { FileRequestSource } from './source.js';

function createNotifier(config: ResolvedConfig): Notifier {
  if (config.notifier.type === 'console') return new ConsoleNotifier();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('notifier "telegram" requires the TELEGRAM_BOT_TOKEN environment variable');
  return new TelegramNotifier(token, config.notifier.chatId);
}

/** Wires the real implementations. Tests build PipelineDeps by hand instead. */
export async function createDefaultDeps(config: ResolvedConfig): Promise<PipelineDeps> {
  return {
    config,
    source: new FileRequestSource(config.inboxDir),
    git: createGit(exec, config),
    agent: createAgentRunner(exec, { ...config.agent, remote: config.remote }),
    runSetup: (dir, { trusted, home }) =>
      runCommands(exec, config.setup, dir, { remote: config.remote, allowGitTransport: trusted, home }),
    runGates: (dir, { home }) => runCommands(exec, config.gates, dir, { remote: config.remote, home }),
    notifier: createNotifier(config),
    playbook: await readFile(config.agent.playbook, 'utf8'),
    now: () => new Date(),
    log: (message) => console.error(`${new Date().toISOString()} ${message}`),
  };
}
