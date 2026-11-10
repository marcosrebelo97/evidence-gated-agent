import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * published — gates green and branch pushed
 * ready     — gates green, push disabled by config
 * blocked   — agent judged the request ambiguous and asked questions
 * rejected  — agent declared success but the evidence did not confirm it
 * failed    — agent or infrastructure failure
 */
export const OUTCOMES = ['published', 'ready', 'blocked', 'rejected', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

const entrySchema = z.object({
  id: z.string(),
  status: z.enum(['running', ...OUTCOMES]),
  branch: z.string().optional(),
  commit: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  reasons: z.array(z.string()).default([]),
  costUsd: z.number().optional(),
});

export type LedgerEntry = z.infer<typeof entrySchema>;

const fileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), entrySchema),
});

export interface FinishPatch {
  status: Outcome;
  reasons: string[];
  costUsd?: number | undefined;
  commit?: string | undefined;
}

/**
 * Records every request ever started, so each one runs exactly once.
 * Writes are atomic (temp file + rename): a crash never leaves a half-written ledger.
 * Callers must hold the poll lock while mutating it.
 */
export class Ledger {
  private constructor(
    private readonly file: string,
    private readonly entries: Map<string, LedgerEntry>,
  ) {}

  static async open(file: string): Promise<Ledger> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Ledger(file, new Map());
      throw error;
    }
    const parsed = fileSchema.parse(JSON.parse(raw));
    return new Ledger(file, new Map(Object.entries(parsed.entries)));
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): LedgerEntry | undefined {
    return this.entries.get(id);
  }

  list(): LedgerEntry[] {
    return [...this.entries.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async start(id: string, branch: string, now: Date): Promise<void> {
    if (this.entries.has(id)) throw new Error(`request ${id} is already in the ledger`);
    this.entries.set(id, { id, status: 'running', branch, startedAt: now.toISOString(), reasons: [] });
    await this.persist();
  }

  async finish(id: string, patch: FinishPatch, now: Date): Promise<LedgerEntry> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`request ${id} is not in the ledger`);
    if (entry.status !== 'running') throw new Error(`request ${id} already finished as ${entry.status}`);
    const finished: LedgerEntry = {
      ...entry,
      status: patch.status,
      reasons: patch.reasons,
      finishedAt: now.toISOString(),
      ...(patch.costUsd !== undefined ? { costUsd: patch.costUsd } : {}),
      ...(patch.commit !== undefined ? { commit: patch.commit } : {}),
    };
    this.entries.set(id, finished);
    await this.persist();
    return finished;
  }

  /** Allows a finished request to be attempted again. */
  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`request ${id} is not in the ledger`);
    if (entry.status === 'running') throw new Error(`request ${id} is running and cannot be removed`);
    this.entries.delete(id);
    await this.persist();
  }

  /**
   * With the lock held, a "running" entry can only mean a previous process died mid-run.
   * It becomes "failed" so it is visible and never silently retried.
   */
  async recoverInterrupted(now: Date): Promise<string[]> {
    const interrupted = [...this.entries.values()].filter((entry) => entry.status === 'running');
    for (const entry of interrupted) {
      this.entries.set(entry.id, {
        ...entry,
        status: 'failed',
        finishedAt: now.toISOString(),
        reasons: ['interrupted: the previous run did not finish (process died or was killed)'],
      });
    }
    if (interrupted.length > 0) await this.persist();
    return interrupted.map((entry) => entry.id);
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const data = { version: 1, entries: Object.fromEntries(this.entries) };
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(temp, this.file);
  }
}
