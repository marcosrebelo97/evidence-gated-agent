import { describe, expect, it } from 'vitest';
import { exec } from '../src/exec.js';
import { decide, gatesAreWorthRunning, runCommands, type Evidence, type GateResult } from '../src/gates.js';

const green = (name: string): GateResult => ({ name, passed: true, exitCode: 0, timedOut: false, durationMs: 10, outputTail: '' });
const red = (name: string, exitCode = 1, timedOut = false): GateResult => ({ ...green(name), passed: false, exitCode, timedOut });

const publishable: Evidence = {
  declared: 'implemented',
  commitsAhead: 1,
  dirtyFiles: [],
  forbiddenTouched: [],
  gates: [green('tests'), green('typecheck')],
};

describe('decide', () => {
  it('publishes only when every piece of evidence agrees', () => {
    expect(decide(publishable)).toEqual({ publish: true, outcome: 'approved', reasons: [] });
  });

  it('rejects a self-declared success without a commit', () => {
    const decision = decide({ ...publishable, commitsAhead: 0 });
    expect(decision).toMatchObject({ publish: false, outcome: 'rejected' });
    expect(decision.reasons).toContain('agent declared implemented but there is no new commit');
  });

  it('rejects when work was left uncommitted', () => {
    const decision = decide({ ...publishable, dirtyFiles: ['src/a.ts'] });
    expect(decision.publish).toBe(false);
    expect(decision.reasons[0]).toMatch(/uncommitted changes .* src\/a\.ts/);
  });

  it('rejects when a forbidden path was touched', () => {
    const decision = decide({ ...publishable, forbiddenTouched: ['.env'] });
    expect(decision.reasons).toEqual(['forbidden paths touched: .env']);
  });

  it('rejects and names every failing gate', () => {
    const decision = decide({ ...publishable, gates: [red('tests', 1), green('lint'), red('typecheck', 143, true)] });
    expect(decision.reasons).toEqual(['gate "tests" failed (exit 1)', 'gate "typecheck" failed (timeout)']);
  });

  it('never publishes without gate evidence', () => {
    const decision = decide({ ...publishable, gates: [] });
    expect(decision).toMatchObject({ publish: false, outcome: 'rejected' });
    expect(decision.reasons[0]).toMatch(/no gate was executed/);
  });

  it('keeps "blocked" as its own outcome and flags stray commits', () => {
    expect(decide({ ...publishable, declared: 'blocked', commitsAhead: 0 })).toEqual({
      publish: false,
      outcome: 'blocked',
      reasons: ['agent blocked: the request needs clarification'],
    });
    expect(decide({ ...publishable, declared: 'blocked', commitsAhead: 2 }).reasons[1]).toMatch(/created 2 commit/);
  });

  it('reports the contract violation when the agent failed', () => {
    expect(decide({ ...publishable, declared: 'failed', contractViolation: 'agent timed out after 10 ms' })).toEqual({
      publish: false,
      outcome: 'failed',
      reasons: ['agent timed out after 10 ms'],
    });
  });
});

describe('gatesAreWorthRunning', () => {
  it('skips gates when cheaper evidence already rules publication out', () => {
    const { gates: _gates, ...base } = publishable;
    expect(gatesAreWorthRunning(base)).toBe(true);
    expect(gatesAreWorthRunning({ ...base, declared: 'blocked' })).toBe(false);
    expect(gatesAreWorthRunning({ ...base, commitsAhead: 0 })).toBe(false);
    expect(gatesAreWorthRunning({ ...base, dirtyFiles: ['x'] })).toBe(false);
    expect(gatesAreWorthRunning({ ...base, forbiddenTouched: ['.env'] })).toBe(false);
  });
});

describe('runCommands', () => {
  it('runs every command, even after a failure, and keeps the output tail', async () => {
    const results = await runCommands(
      exec,
      [
        { name: 'fails', command: process.execPath, args: ['-e', 'console.error("boom"); process.exit(2)'], timeoutMs: 10_000 },
        { name: 'passes', command: process.execPath, args: ['-e', 'console.log("ok")'], timeoutMs: 10_000 },
      ],
      process.cwd(),
    );
    expect(results.map((r) => [r.name, r.passed, r.exitCode])).toEqual([
      ['fails', false, 2],
      ['passes', true, 0],
    ]);
    expect(results[0]?.outputTail).toContain('boom');
  });
});
