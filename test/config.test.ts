import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYBOOK, defaultWorkDir, ORCHESTRATOR_ROOT, parseConfig } from '../src/config.js';
import { agentPassEnv } from '../src/deps.js';
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
    expect(config.workDir).toBe(defaultWorkDir('/srv/target'));
    expect(config.workDir).toMatch(/\.local\/state\/evidence-gated-agent\/target-[0-9a-f]{8}$/);
    expect(config.forbiddenPaths).toEqual(['.env', '.env.*']);
    expect(config.agent.playbook).toBe(DEFAULT_PLAYBOOK);
    expect(config.notifier).toEqual({ type: 'console' });
    expect(config.push).toBe(true);
    // The agent loads only the target project's settings and no MCP server from the host.
    expect(config.agent.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--setting-sources',
      'project',
      '--strict-mcp-config',
    ]);
    expect(config.attentionPaths).toEqual(expect.arrayContaining(['package-lock.json', '.husky/**']));
    expect(config.isolateHome).toBe(true);
    expect(config.isolation).toEqual({ mode: 'none' });
    // An isolated HOME has no git identity: the agent's commits always have an explicit author.
    expect(config.agent.gitAuthor.name).toBe('evidence-gated-agent');
  });

  it('keeps state for different repositories apart', () => {
    expect(defaultWorkDir('/a/app')).not.toBe(defaultWorkDir('/b/app'));
  });

  it('refuses a workDir inside the target repository', () => {
    expect(() => parseConfig({ ...minimal, workDir: '../target/.state' }, '/srv/runner')).toThrow(/outside repoPath/);
  });

  it("refuses a workDir inside the orchestrator, where the agent would load the orchestrator's CLAUDE.md", () => {
    expect(() => parseConfig({ ...minimal, workDir: join(ORCHESTRATOR_ROOT, '.agent-runner') }, '/srv/runner')).toThrow(
      /outside the orchestrator/,
    );
  });

  it('refuses a configuration without gates', () => {
    expect(() => parseConfig({ ...minimal, gates: [] }, '/srv')).toThrow(/nothing is published without evidence/);
  });

  it('rejects a branch prefix that could collide with real branches', () => {
    expect(() => parseConfig({ ...minimal, branchPrefix: 'main' }, '/srv')).toThrow();
  });

  it('fills the container defaults: local image, no network for the gates', () => {
    expect(parseConfig({ ...minimal, isolation: { mode: 'container' } }, '/srv').isolation).toEqual({
      mode: 'container',
      engine: 'docker',
      image: 'evidence-gated-agent-runner',
      network: { agent: 'bridge', setup: 'bridge', gates: 'none' },
      memory: '4g',
      pids: 1024,
    });
  });

  it("refuses the host network, and a container mode that would need the user's HOME", () => {
    const withNetwork = (gates: string) => ({ ...minimal, isolation: { mode: 'container', network: { gates } } });
    expect(() => parseConfig(withNetwork('host'), '/srv')).toThrow(/host network is not allowed/);
    expect(() => parseConfig(withNetwork('container:other'), '/srv')).toThrow(/docker network name/);
    expect(() => parseConfig({ ...minimal, isolation: { mode: 'container', image: '-v=/:/host' } }, '/srv')).toThrow(
      /docker image reference/,
    );
    expect(() => parseConfig({ ...minimal, isolateHome: false, isolation: { mode: 'container' } }, '/srv')).toThrow(
      /requires isolateHome/,
    );
  });
});

describe('agentPassEnv', () => {
  it('passes the Claude Code credentials only when the HOME is isolated', () => {
    expect(agentPassEnv(parseConfig(minimal, '/srv/runner'))).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    // With the user's HOME, a stored subscription login must not lose to an API key in the environment.
    expect(agentPassEnv(parseConfig({ ...minimal, isolateHome: false }, '/srv/runner'))).toEqual([]);
    const bedrock = parseConfig({ ...minimal, agent: { passEnv: ['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_API_KEY'] } }, '/srv/runner');
    expect(agentPassEnv(bedrock)).toEqual(['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
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
