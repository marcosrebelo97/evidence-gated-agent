import { describe, expect, it, vi } from 'vitest';
import { ConsoleNotifier, formatSummary, TelegramNotifier, truncate, type RunSummary } from '../src/notify.js';

const summary: RunSummary = {
  id: 'REQ-2',
  title: 'Ajustar relatório',
  requestedBy: 'ana',
  outcome: 'blocked',
  branch: 'agent/REQ-2-ajustar-relatorio',
  reasons: ['agent blocked: the request needs clarification'],
  attention: [],
  report: '1. Qual relatório?\n2. Qual coluna?',
  costUsd: 0.04,
  durationMs: 34_000,
};

describe('formatSummary', () => {
  it('leads with the outcome and carries the questions to the requester', () => {
    const text = formatSummary(summary);
    expect(text.split('\n')[0]).toBe('❓ Bloqueado: a solicitação precisa de esclarecimento — REQ-2');
    expect(text).toContain('custo do agente: US$ 0.04');
    expect(text).toContain('1. Qual relatório?');
  });

  it('flags files that define gates or agents to the reviewer', () => {
    const text = formatSummary({ ...summary, outcome: 'published', commit: 'abcdef1234567890', attention: ['package.json'] });
    expect(text).toContain('Branch: agent/REQ-2-ajustar-relatorio @ abcdef1234');
    expect(text).toContain('⚠️ Atenção do revisor');
    expect(text).toContain('package.json');
  });

  it('omits empty sections', () => {
    const text = formatSummary({ ...summary, outcome: 'published', reasons: [], report: '', costUsd: undefined });
    expect(text).not.toContain('Motivos');
    expect(text).not.toContain('Relatório');
    expect(text).not.toContain('custo');
  });
});

describe('truncate', () => {
  it('respects the limit', () => {
    expect(truncate('x'.repeat(5000), 4096).length).toBeLessThanOrEqual(4096);
    expect(truncate('short', 4096)).toBe('short');
  });
});

describe('ConsoleNotifier', () => {
  it('writes the formatted summary', async () => {
    const write = vi.fn();
    await new ConsoleNotifier(write).notify(summary);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('REQ-2'));
  });
});

describe('TelegramNotifier', () => {
  it('sends plain text to the configured chat', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await new TelegramNotifier('TOKEN', '42', fetchImpl as unknown as typeof fetch).notify(summary);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: '42', disable_web_page_preview: true });
  });

  it('fails without leaking the token', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const notifier = new TelegramNotifier('SECRET-TOKEN', '42', fetchImpl as unknown as typeof fetch);
    const error = await notifier.notify(summary).catch((e: Error) => e);
    expect(String(error)).toContain('401');
    expect(String(error)).not.toContain('SECRET-TOKEN');
  });
});
