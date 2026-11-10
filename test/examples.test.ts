import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { FileRequestSource } from '../src/source.js';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('documented examples', () => {
  it('the example config is valid and never allows the agent to push', async () => {
    const config = await loadConfig(`${root}agent.config.example.json`);
    expect(config.gates.length).toBeGreaterThan(0);
    const disallowed = config.agent.args.slice(config.agent.args.indexOf('--disallowedTools') + 1);
    expect(disallowed).toContain('Bash(git push:*)');
  });

  it('the example inbox has one clear request, one ambiguous and one pending', async () => {
    const scan = await new FileRequestSource(`${root}examples/inbox`).scan();
    expect(scan.invalid).toEqual([]);
    expect(scan.approved.map((loaded) => loaded.request.id)).toEqual(['REQ-101', 'REQ-102']);
    expect(scan.approved[0]?.attachmentPaths[0]).toMatch(/listagem-pedidos\.png$/);
    expect(scan.pending).toEqual(['REQ-103']);
  });
});
