import type { ApprovedRequest } from '../request.js';

export interface PromptInput {
  template: string;
  request: ApprovedRequest;
  branch: string;
  baseRef: string;
  runDir: string;
  statusFile: string;
  reportFile: string;
  /** Absolute paths of the attachments copied into the run directory. */
  attachments: readonly string[];
}

const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;

/** Keeps request text from opening or closing the data block it is wrapped in, in any spelling. */
export function neutralizeDelimiters(text: string): string {
  return text.replace(/<(?=\s*\/?\s*solicitacao)/gi, '‹');
}

export function formatRequest(request: ApprovedRequest): string {
  return neutralizeDelimiters(
    [
      `ID: ${request.id}`,
      `Título: ${request.title}`,
      `Solicitante: ${request.requestedBy}`,
      `Aprovado por: ${request.approval.approvedBy} em ${request.approval.approvedAt}`,
      '',
      request.description,
    ].join('\n'),
  );
}

/**
 * Fills the playbook. Values are inserted in a single pass, so placeholder-like
 * text inside the request is never expanded, and an unknown placeholder fails loudly.
 */
export function buildPrompt(input: PromptInput): string {
  const values: Record<string, string> = {
    BRANCH: input.branch,
    BASE_REF: input.baseRef,
    REQUEST: formatRequest(input.request),
    ATTACHMENTS:
      input.attachments.length > 0 ? input.attachments.map((path) => `- ${path}`).join('\n') : '- (nenhum)',
    RUN_DIR: input.runDir,
    STATUS_FILE: input.statusFile,
    REPORT_FILE: input.reportFile,
  };

  return input.template.replace(PLACEHOLDER, (match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`unknown placeholder ${match} in playbook`);
    return value;
  });
}
