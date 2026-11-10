import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYBOOK, parseConfig } from '../src/config.js';
import { isApproved, supportRequestSchema } from '../src/request.js';

const minimal = {
  repoPath: '../target',
  inboxDir: './inbox',
  agent: {},
  gates: [{ name: 'tests', command: 'npm', args: ['test'] }],
};

describe('parseConfig', () => {
  it('applies safe defaults and resolves paths against the config directory', () => {
    const config = parseConfig(minimal, '/srv/runner');
    expect(config.repoPath).toBe('/srv/target');
    expect(config.inboxDir).toBe('/srv/runner/inbox');
    expect(config.workDir).toBe('/srv/runner/.agent-runner');
    expect(config.forbiddenPaths).toEqual(['.env', '.env.*']);
    expect(config.agent.playbook).toBe(DEFAULT_PLAYBOOK);
    expect(config.notifier).toEqual({ type: 'console' });
    expect(config.push).toBe(true);
  });

  it('refuses a configuration without gates', () => {
    expect(() => parseConfig({ ...minimal, gates: [] }, '/srv')).toThrow(/nothing is published without evidence/);
  });

  it('rejects a branch prefix that could collide with real branches', () => {
    expect(() => parseConfig({ ...minimal, branchPrefix: 'main' }, '/srv')).toThrow();
  });
});

describe('supportRequestSchema', () => {
  const base = {
    id: 'REQ-1',
    title: 'Filtro por data',
    description: 'Adicionar filtro',
    requestedBy: 'ana',
  };

  it('accepts a pending request and reports it as not approved', () => {
    const request = supportRequestSchema.parse(base);
    expect(isApproved(request)).toBe(false);
    expect(request.attachments).toEqual([]);
  });

  it('accepts an approved request', () => {
    const request = supportRequestSchema.parse({
      ...base,
      approval: { approvedBy: 'lead', approvedAt: '2026-01-10T12:00:00-03:00' },
    });
    expect(isApproved(request)).toBe(true);
  });

  it.each(['../etc', 'a/b', 'has space', '', '-leading-dash'])('rejects unsafe id %j', (id) => {
    expect(supportRequestSchema.safeParse({ ...base, id }).success).toBe(false);
  });
});
