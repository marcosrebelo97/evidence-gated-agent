import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isApproved, supportRequestSchema, type ApprovedRequest } from './request.js';

export interface LoadedRequest {
  request: ApprovedRequest;
  /** Absolute paths, verified to exist inside the inbox. */
  attachmentPaths: string[];
}

export interface InboxScan {
  approved: LoadedRequest[];
  pending: string[];
  invalid: { file: string; error: string }[];
}

/** Where approved requests come from. Swap the implementation for an API client. */
export interface RequestSource {
  scan(): Promise<InboxScan>;
}

/**
 * Reads one JSON file per request from a directory. A broken file is reported and
 * skipped, never fatal: one bad request must not stop the others.
 */
export class FileRequestSource implements RequestSource {
  private readonly inboxDir: string;

  constructor(inboxDir: string) {
    this.inboxDir = resolve(inboxDir);
  }

  async scan(): Promise<InboxScan> {
    const scan: InboxScan = { approved: [], pending: [], invalid: [] };
    const files = (await readdir(this.inboxDir)).filter((name) => name.endsWith('.json')).sort();
    const seen = new Set<string>();

    for (const file of files) {
      try {
        const parsed = supportRequestSchema.safeParse(JSON.parse(await readFile(join(this.inboxDir, file), 'utf8')));
        if (!parsed.success) {
          scan.invalid.push({ file, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
          continue;
        }
        const request = parsed.data;
        if (seen.has(request.id)) {
          scan.invalid.push({ file, error: `duplicate request id ${request.id}` });
          continue;
        }
        seen.add(request.id);
        if (!isApproved(request)) {
          scan.pending.push(request.id);
          continue;
        }
        scan.approved.push({ request, attachmentPaths: await this.resolveAttachments(request.attachments) });
      } catch (error) {
        scan.invalid.push({ file, error: (error as Error).message });
      }
    }
    return scan;
  }

  /** Checks the real path, after following symlinks: a link inside the inbox can point anywhere. */
  private async resolveAttachments(attachments: readonly string[]): Promise<string[]> {
    const inbox = await realpath(this.inboxDir);
    const paths: string[] = [];
    const outside = (base: string, path: string) => {
      const rel = relative(base, path);
      return rel === '' || rel.startsWith('..') || isAbsolute(rel);
    };
    for (const attachment of attachments) {
      const requested = resolve(this.inboxDir, attachment);
      if (outside(this.inboxDir, requested)) throw new Error(`attachment outside the inbox: ${attachment}`);
      const real = await realpath(requested).catch(() => {
        throw new Error(`attachment not found: ${attachment}`);
      });
      if (outside(inbox, real)) throw new Error(`attachment outside the inbox: ${attachment}`);
      if (!(await stat(real)).isFile()) throw new Error(`attachment is not a file: ${attachment}`);
      paths.push(real);
    }
    return paths;
  }
}
