import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Lock {
  release(): Promise<void>;
}

export type IsAlive = (pid: number) => boolean;

/** A lock file younger than this with no readable pid is assumed to be mid-creation. */
const FRESH_LOCK_MS = 10_000;

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

export const processIsAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
};

/**
 * Single-instance lock based on exclusive file creation.
 * Returns null when another live process holds it; a lock left by a dead process is taken over.
 */
export async function acquireLock(file: string, isAlive: IsAlive = processIsAlive): Promise<Lock | null> {
  await mkdir(dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      try {
        await handle.writeFile(String(process.pid), 'utf8');
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await rm(file, { force: true });
        },
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }

    const content = await readFile(file, 'utf8').catch(() => '');
    const pid = Number.parseInt(content, 10);
    if (Number.isInteger(pid) && pid > 0) {
      if (isAlive(pid)) return null;
    } else {
      const age = await stat(file)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => Number.POSITIVE_INFINITY);
      if (age < FRESH_LOCK_MS) return null;
    }
    await rm(file, { force: true });
  }

  return null;
}
