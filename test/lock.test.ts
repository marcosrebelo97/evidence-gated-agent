import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  it('does not remove a lock that changed owner during the takeover', async () => {
    await writeFile(file, '999999');
    // Sees the dead pid, but by the time it checks again a live poller (pid 4242) holds the lock.
    let checks = 0;
    const lock = await acquireLock(file, (pid) => {
      if (pid === 999999 && checks++ === 0) {
        writeFileSync(file, '4242');
        return false;
      }
      return pid === 4242;
    });
    expect(lock).toBeNull();
    expect(await readFile(file, 'utf8')).toBe('4242');
  });

  it('lets exactly one of many concurrent pollers take over a stale lock', async () => {
    for (let round = 0; round < 20; round++) {
      await writeFile(file, '999999');
      const deadOnly = (pid: number) => pid !== 999999;
      const locks = await Promise.all(Array.from({ length: 8 }, () => acquireLock(file, deadOnly)));
      expect(locks.filter((lock) => lock !== null)).toHaveLength(1);
      await Promise.all(locks.map((lock) => lock?.release()));
    }
  });

  it('creates the lock already holding its pid, leaving no temporary files behind', async () => {
    const locks = await Promise.all(Array.from({ length: 8 }, () => acquireLock(file, () => true)));
    expect(locks.filter((lock) => lock !== null)).toHaveLength(1);
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    expect(await readdir(dirname(file))).toEqual(['poll.lock']);
    await Promise.all(locks.map((lock) => lock?.release()));
  });

  it('does not steal a lock that is still being created', async () => {
    await writeFile(file, '');
    expect(await acquireLock(file, () => false)).toBeNull();
  });
});
