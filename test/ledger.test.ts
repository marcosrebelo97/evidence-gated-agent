import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/state/ledger.js';

const t0 = new Date('2026-01-10T12:00:00Z');
const t1 = new Date('2026-01-10T12:09:00Z');

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  file = join(dir, 'state', 'ledger.json');
});

describe('Ledger', () => {
  it('starts empty when the file does not exist', async () => {
    const ledger = await Ledger.open(file);
    expect(ledger.list()).toEqual([]);
  });

  it('persists start and finish across reopen', async () => {
    const ledger = await Ledger.open(file);
    await ledger.start('REQ-1', 'agent/REQ-1-x', t0);
    await ledger.finish('REQ-1', { status: 'published', reasons: [], costUsd: 0.42 }, t1);

    const reopened = await Ledger.open(file);
    expect(reopened.get('REQ-1')).toEqual({
      id: 'REQ-1',
      status: 'published',
      branch: 'agent/REQ-1-x',
      startedAt: t0.toISOString(),
      finishedAt: t1.toISOString(),
      reasons: [],
      costUsd: 0.42,
    });
  });

  it('refuses to start the same request twice (idempotency)', async () => {
    const ledger = await Ledger.open(file);
    await ledger.start('REQ-1', 'b', t0);
    await expect(ledger.start('REQ-1', 'b', t0)).rejects.toThrow(/already in the ledger/);
  });

  it('refuses to finish a request twice', async () => {
    const ledger = await Ledger.open(file);
    await ledger.start('REQ-1', 'b', t0);
    await ledger.finish('REQ-1', { status: 'blocked', reasons: ['x'] }, t1);
    await expect(ledger.finish('REQ-1', { status: 'published', reasons: [] }, t1)).rejects.toThrow(
      /already finished/,
    );
  });

  it('marks runs left as "running" by a dead process as failed', async () => {
    const crashed = await Ledger.open(file);
    await crashed.start('REQ-1', 'b', t0);

    const next = await Ledger.open(file);
    expect(await next.recoverInterrupted(t1)).toEqual(['REQ-1']);
    expect(next.get('REQ-1')?.status).toBe('failed');
    expect(next.get('REQ-1')?.reasons[0]).toMatch(/interrupted/);
  });

  it('allows retry only for finished requests', async () => {
    const ledger = await Ledger.open(file);
    await ledger.start('REQ-1', 'b', t0);
    await expect(ledger.remove('REQ-1')).rejects.toThrow(/running/);
    await ledger.finish('REQ-1', { status: 'failed', reasons: [] }, t1);
    await ledger.remove('REQ-1');
    expect(ledger.has('REQ-1')).toBe(false);
  });

  it('writes atomically, leaving no temp files behind', async () => {
    const ledger = await Ledger.open(file);
    await ledger.start('REQ-1', 'b', t0);
    const files = await readdir(join(dir, 'state'));
    expect(files).toEqual(['ledger.json']);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
  });

  it('fails loudly on a corrupted ledger instead of starting over', async () => {
    await Ledger.open(file).then((l) => l.start('REQ-1', 'b', t0));
    await writeFile(file, '{"version":1,"entries":{"REQ-1":{"status":"weird"}}}');
    await expect(Ledger.open(file)).rejects.toThrow();
  });
});
