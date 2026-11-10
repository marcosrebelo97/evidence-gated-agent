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

  it('kills the whole process group on timeout, not only the direct child', async () => {
    const parent = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      console.log(grandchild.pid);
      setTimeout(() => {}, 60000);`;
    const result = await exec(node, ['-e', parent], { cwd: process.cwd(), timeoutMs: 500 });
    const grandchildPid = Number.parseInt(result.stdout, 10);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it('does not hang when a detached grandchild keeps stdout open', async () => {
    const parent = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: 'inherit' }).unref();
      console.log('parent done');`;
    const started = Date.now();
    const result = await exec(node, ['-e', parent], { cwd: process.cwd() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('parent done');
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('passes only the given variables when inheritEnv is false', async () => {
    process.env.EGA_EXEC_SECRET = 'leak';
    const result = await exec(node, ['-e', 'process.stdout.write(String(process.env.EGA_EXEC_SECRET) + "|" + process.env.ONLY)'], {
      cwd: process.cwd(),
      env: { ONLY: 'this' },
      inheritEnv: false,
    });
    delete process.env.EGA_EXEC_SECRET;
    expect(result.stdout).toBe('undefined|this');
  });
});

describe('tail', () => {
  it('keeps the end of long text', () => {
    expect(tail('abcdef', 3)).toBe('…def');
    expect(tail('abc', 3)).toBe('abc');
  });
});
