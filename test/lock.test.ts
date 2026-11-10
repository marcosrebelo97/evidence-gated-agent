import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../src/state/lock.js';

let file: string;

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), 'lock-')), 'poll.lock');
});

describe('acquireLock', () => {
  it('records the owner pid and releases the file', async () => {
    const lock = await acquireLock(file);
    expect(lock).not.toBeNull();
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    await lock?.release();
    await expect(readFile(file)).rejects.toThrow();
  });

  it('refuses a second instance while the owner is alive', async () => {
    const first = await acquireLock(file);
    const second = await acquireLock(file, () => true);
    expect(second).toBeNull();
    await first?.release();
  });

  it('takes over a lock left by a dead process', async () => {
    await writeFile(file, '999999');
    const lock = await acquireLock(file, () => false);
    expect(lock).not.toBeNull();
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
  });

  it('does not steal a lock that is still being created', async () => {
    await writeFile(file, '');
    expect(await acquireLock(file, () => false)).toBeNull();
  });
});
