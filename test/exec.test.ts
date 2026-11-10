import { describe, expect, it } from 'vitest';
import { exec, tail } from '../src/exec.js';

const node = process.execPath;

describe('exec', () => {
  it('captures stdout, stderr and exit code', async () => {
    const result = await exec(
      node,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'],
      { cwd: process.cwd() },
    );
    expect(result).toMatchObject({ code: 3, stdout: 'out', stderr: 'err', timedOut: false });
  });

  it('feeds input through stdin', async () => {
    const result = await exec(
      node,
      ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))'],
      { cwd: process.cwd(), input: 'prompt' },
    );
    expect(result.stdout).toBe('PROMPT');
  });

  it('never interprets arguments through a shell', async () => {
    const result = await exec(node, ['-e', 'process.stdout.write(process.argv[1])', '$(whoami); rm -rf /'], {
      cwd: process.cwd(),
    });
    expect(result.stdout).toBe('$(whoami); rm -rf /');
  });

  it('resolves with code 127 when the command does not exist', async () => {
    const result = await exec('definitely-not-a-real-command-xyz', [], { cwd: process.cwd() });
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('ENOENT');
  });

  it('kills the process on timeout', async () => {
    const result = await exec(node, ['-e', 'setTimeout(() => {}, 60_000)'], {
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });
});

describe('tail', () => {
  it('keeps the end of long text', () => {
    expect(tail('abcdef', 3)).toBe('…def');
    expect(tail('abc', 3)).toBe('abc');
  });
});
