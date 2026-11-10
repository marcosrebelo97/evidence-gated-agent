import type { Outcome } from './state/ledger.js';

export interface RunSummary {
  id: string;
  title: string;
  requestedBy: string;
  outcome: Outcome;
  branch: string;
  reasons: string[];
  report: string;
  costUsd?: number | undefined;
  durationMs: number;
}

export interface Notifier {
  notify(summary: RunSummary): Promise<void>;
}

const HEADLINES: Record<Outcome, string> = {
  published: '✅ Branch pronta para revisão',
  ready: '✅ Implementado e validado (push desativado)',
  blocked: '❓ Bloqueado: a solicitação precisa de esclarecimento',
  rejected: '⛔ Rejeitado: a evidência não confirmou a entrega',
  failed: '❌ Falhou',
};

const TELEGRAM_LIMIT = 4_096;

export function formatSummary(summary: RunSummary): string {
  const minutes = (summary.durationMs / 60_000).toFixed(1);
  const lines = [
    `${HEADLINES[summary.outcome]} — ${summary.id}`,
    summary.title,
    `Solicitante: ${summary.requestedBy}`,
    `Branch: ${summary.branch}`,
    `Duração: ${minutes} min${summary.costUsd !== undefined ? ` · custo do agente: US$ ${summary.costUsd.toFixed(2)}` : ''}`,
  ];
  if (summary.reasons.length > 0) lines.push('', 'Motivos:', ...summary.reasons.map((reason) => `• ${reason}`));
  if (summary.report.trim()) lines.push('', 'Relatório do agente:', summary.report.trim());
  return lines.join('\n');
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 30)}\n… (relatório completo no run)`;
}

export class ConsoleNotifier implements Notifier {
  constructor(private readonly write: (text: string) => void = (text) => console.log(text)) {}

  async notify(summary: RunSummary): Promise<void> {
    this.write(`${formatSummary(summary)}\n`);
  }
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async notify(summary: RunSummary): Promise<void> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Plain text on purpose: agent reports are not escaped for Telegram markup.
      body: JSON.stringify({
        chat_id: this.chatId,
        text: truncate(formatSummary(summary), TELEGRAM_LIMIT),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // The URL carries the token, so it never goes into the error message.
    if (!response.ok) throw new Error(`Telegram sendMessage responded ${response.status}`);
  }
}
