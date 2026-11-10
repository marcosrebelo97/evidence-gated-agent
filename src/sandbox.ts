/** Variables every child gets. Everything else (tokens, cloud credentials, SSH agent) is dropped. */
const BASE_VARIABLES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TMPDIR', 'TZ',
  // Network and tool configuration, without which claude and npm fail behind a corporate proxy.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR',
];

export interface SandboxEnvOptions {
  /** Extra variable names to pass through, e.g. ANTHROPIC_API_KEY for the agent. */
  passEnv?: readonly string[];
  /** Remote whose push URL is disabled. */
  remote: string;
  /**
   * Keep git transports working. Only for trusted code: the setup of the untouched base,
   * which may need git dependencies. Never for the agent or for anything on its commit.
   */
  allowGitTransport?: boolean;
  extra?: Record<string, string>;
  source?: NodeJS.ProcessEnv;
}

/**
 * Environment for code the orchestrator does not trust: the agent and the gates
 * (which run tests the agent may have written). Only allowlisted variables pass,
 * so the orchestrator's secrets never reach them, and git is configured so no
 * transport works for the agent's own git commands.
 *
 * Code the agent writes can unset these variables, so this blocks the direct
 * path, not a determined one: OS-level isolation (a user without push
 * credentials) is still required. Publishing safety does not rely on it —
 * see the hook/config protections in git.ts.
 */
export function sandboxEnv({
  passEnv = [],
  remote,
  allowGitTransport = false,
  extra = {},
  source = process.env,
}: SandboxEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (BASE_VARIABLES.includes(name) || name.startsWith('LC_') || passEnv.includes(name)) env[name] = value;
  }

  const gitConfig: [string, string][] = [[`remote.${remote}.pushurl`, 'file:///dev/null/push-disabled-by-orchestrator']];
  if (!allowGitTransport) gitConfig.unshift(['protocol.allow', 'never']);
  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.GIT_TERMINAL_PROMPT = '0';

  return { ...env, ...extra };
}
