import type { Exec, ExecOptions, ExecResult } from './exec.js';

/** A host directory the isolated process may see, at the same path. */
export interface Mount {
  path: string;
  writable: boolean;
}

/**
 * Which network an isolated process gets. `none` is for git commands the orchestrator runs
 * inside the agent's repository; the others map to the `isolation.network` config.
 */
export type NetworkRole = 'agent' | 'setup' | 'gates' | 'none';

export interface IsolatedExecOptions extends ExecOptions {
  /** Everything the process needs from the host. With a container, nothing else exists. */
  mounts: readonly Mount[];
  network: NetworkRole;
  /** Always false: an isolated process gets only the environment it is given. */
  inheritEnv: false;
}

/**
 * Where untrusted code runs: the agent, the setup and gates on its commit, and git inside
 * its repository. Callers say what the process needs (mounts, network); the implementation
 * decides how much of that it can enforce.
 */
export interface Isolation {
  readonly mode: 'none' | 'container';
  exec(command: string, args: readonly string[], options: IsolatedExecOptions): Promise<ExecResult>;
}

/**
 * No isolation beyond the restricted environment: the process runs on the host as the same
 * user, so `mounts` and `network` are declarations, not limits.
 */
export function hostIsolation(exec: Exec): Isolation {
  return {
    mode: 'none',
    exec: (command, args, { mounts: _mounts, network: _network, ...options }) => exec(command, args, options),
  };
}
