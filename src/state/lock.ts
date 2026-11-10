import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Lock {
  release(): Promise<void>;
}

export type IsAlive = (pid: number) => boolean;

/** A lock file younger than this with no readable pid is assumed to be mid-creation (e.g. an older version). */
const FRESH_LOCK_MS = 10_000;
/** A takeover guard older than this was left by a process that died mid-takeover. */
const STALE_GUARD_MS = 60_000;

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

async function readPid(file: string): Promise<number | undefined> {
  const pid = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function ageMs(file: string): Promise<number> {
  return stat(file)
    .then((info) => Date.now() - info.mtimeMs)
    .catch(() => Number.POSITIVE_INFINITY);
}

/**
 * Creates `file` with `content` only if it does not exist. The content is written to a
 * temporary file first and hard-linked into place, which is atomic: the file never exists
 * empty, so a crash during creation cannot leave a lock without an owner pid.
 */
async function createExclusive(file: string, content: string): Promise<boolean> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, content, 'utf8');
  try {
    await link(temp, file);
    return true;
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Removes a lock left by a dead process. Only one contender may do it, under a guard,
 * and only if the file still holds the dead pid it saw: otherwise a slow contender
 * could delete a lock that a faster one had just created, and both would run.
 */
async function takeOverStale(file: string, deadPid: number | undefined): Promise<void> {
  const guard = `${file}.takeover`;
  if (!(await createExclusive(guard, String(process.pid)))) {
    if ((await ageMs(guard)) > STALE_GUARD_MS) await rm(guard, { force: true });
    return;
  }
  try {
    if ((await readPid(file)) === deadPid) await rm(file, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
}

/**
 * Single-instance lock based on exclusive file creation.
 * Returns null when another live process holds it; a lock left by a dead process is taken over.
 */
export async function acquireLock(file: string, isAlive: IsAlive = processIsAlive): Promise<Lock | null> {
  await mkdir(dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createExclusive(file, String(process.pid))) {
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await rm(file, { force: true });
        },
      };
    }

    const pid = await readPid(file);
    if (pid !== undefined && isAlive(pid)) return null;
    if (pid === undefined && (await ageMs(file)) < FRESH_LOCK_MS) return null;
    await takeOverStale(file, pid);
  }

  return null;
}
