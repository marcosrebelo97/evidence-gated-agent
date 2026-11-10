import type { AgentStatus } from './agent/runner.js';
import type { CommandSpec } from './config.js';
import { tail } from './exec.js';
import type { Isolation, NetworkRole } from './isolation.js';
import { sandboxEnv } from './sandbox.js';

export interface GateResult {
  name: string;
  passed: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

const OUTPUT_TAIL_CHARS = 3_000;

export interface CommandSandbox {
  remote: string;
  network: Exclude<NetworkRole, 'agent'>;
  allowGitTransport?: boolean;
  home?: string | undefined;
}

/**
 * Runs every command and records the outcome. It does not stop at the first failure:
 * the reviewer gets the full picture of what is red. Each command runs in the restricted
 * environment, since gates execute tests the agent may have written; it sees only `cwd`
 * and its HOME.
 */
export async function runCommands(
  isolation: Isolation,
  commands: readonly CommandSpec[],
  cwd: string,
  sandbox: CommandSandbox,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  const mounts = [{ path: cwd, writable: true }, ...(sandbox.home ? [{ path: sandbox.home, writable: true }] : [])];
  for (const spec of commands) {
    const result = await isolation.exec(spec.command, spec.args, {
      cwd,
      timeoutMs: spec.timeoutMs,
      mounts,
      network: sandbox.network,
      env: sandboxEnv({
        remote: sandbox.remote,
        passEnv: spec.passEnv,
        allowGitTransport: sandbox.allowGitTransport ?? false,
        home: sandbox.home,
      }),
      inheritEnv: false,
      killGroupOnExit: true,
    });
    results.push({
      name: spec.name,
      passed: result.code === 0 && !result.timedOut,
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      outputTail: tail(`${result.stdout}\n${result.stderr}`.trim(), OUTPUT_TAIL_CHARS),
    });
  }
  return results;
}

export interface Evidence {
  declared: AgentStatus;
  contractViolation?: string | undefined;
  /** The exact commit the gates verified and that would be pushed. */
  commit?: string | undefined;
  commitsAhead: number;
  dirtyFiles: string[];
  forbiddenTouched: string[];
  gates: GateResult[];
}

export type Decision =
  | { publish: true; outcome: 'approved'; reasons: [] }
  | { publish: false; outcome: 'blocked' | 'failed' | 'rejected'; reasons: string[] };

/** Gates only run when the cheaper evidence already points to a publishable branch. */
export function gatesAreWorthRunning(e: Omit<Evidence, 'gates'>): boolean {
  return e.declared === 'implemented' && e.commitsAhead > 0 && e.dirtyFiles.length === 0 && e.forbiddenTouched.length === 0;
}

/**
 * The publish decision. Pure on purpose: the agent's self-declaration is only a
 * precondition, and every other condition is checked against objective evidence.
 */
export function decide(e: Evidence): Decision {
  if (e.declared === 'failed') {
    return { publish: false, outcome: 'failed', reasons: [e.contractViolation ?? 'agent reported failure'] };
  }

  if (e.declared === 'blocked') {
    const reasons = ['agent blocked: the request needs clarification'];
    if (e.commitsAhead > 0) {
      reasons.push(`agent declared blocked but created ${e.commitsAhead} commit(s); nothing will be published`);
    }
    return { publish: false, outcome: 'blocked', reasons };
  }

  const reasons: string[] = [];
  if (e.commitsAhead === 0) reasons.push('agent declared implemented but there is no new commit');
  else if (!e.commit) reasons.push('the verified commit id was not recorded');
  if (e.dirtyFiles.length > 0) {
    reasons.push(`uncommitted changes left in the agent repository (gates would not reflect the commit): ${e.dirtyFiles.join(', ')}`);
  }
  if (e.forbiddenTouched.length > 0) reasons.push(`forbidden paths touched: ${e.forbiddenTouched.join(', ')}`);
  for (const gate of e.gates.filter((g) => !g.passed)) {
    reasons.push(`gate "${gate.name}" failed (${gate.timedOut ? 'timeout' : `exit ${gate.exitCode}`})`);
  }
  if (reasons.length === 0 && e.gates.length === 0) reasons.push('no gate was executed: nothing is published without evidence');

  return reasons.length > 0 ? { publish: false, outcome: 'rejected', reasons } : { publish: true, outcome: 'approved', reasons: [] };
}
