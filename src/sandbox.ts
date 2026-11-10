/** Variables every child gets. Everything else (tokens, cloud credentials, SSH agent) is dropped. */
const BASE_VARIABLES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TMPDIR', 'TZ'];

export interface SandboxEnvOptions {
  /** Extra variable names to pass through, e.g. ANTHROPIC_API_KEY for the agent. */
  passEnv?: readonly string[];
  /** Remote whose push URL is disabled. */
  remote: string;
  extra?: Record<string, string>;
  source?: NodeJS.ProcessEnv;
}

/**
 * Environment for code the orchestrator does not trust: the agent and the gates
 * (which run tests the agent may have written). Only allowlisted variables pass,
 * and git is configured so no transport works — the agent cannot push, fetch or
 * clone, even through a script it wrote. Publishing stays with the orchestrator.
 *
 * This narrows what an agent can reach; it does not replace OS-level isolation.
 */
export function sandboxEnv({ passEnv = [], remote, extra = {}, source = process.env }: SandboxEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (BASE_VARIABLES.includes(name) || name.startsWith('LC_') || passEnv.includes(name)) env[name] = value;
  }

  const gitConfig: [string, string][] = [
    ['protocol.allow', 'never'],
    [`remote.${remote}.pushurl`, 'file:///dev/null/push-disabled-by-orchestrator'],
  ];
  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.GIT_TERMINAL_PROMPT = '0';

  return { ...env, ...extra };
}
