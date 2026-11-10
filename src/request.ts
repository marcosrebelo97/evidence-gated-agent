import { z } from 'zod';

/**
 * A support request as it arrives from the source system.
 * The id is restricted because it becomes part of a branch name and of paths on disk.
 */
export const supportRequestSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'id must be 1-64 chars of [A-Za-z0-9_-]'),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10_000),
  requestedBy: z.string().trim().min(1).max(200),
  attachments: z.array(z.string().min(1)).max(10).default([]),
  approval: z
    .object({
      approvedBy: z.string().trim().min(1).max(200),
      approvedAt: z.iso.datetime({ offset: true }),
    })
    .optional(),
});

export type SupportRequest = z.infer<typeof supportRequestSchema>;

/** A request whose approval is guaranteed to be present. */
export type ApprovedRequest = SupportRequest & { approval: NonNullable<SupportRequest['approval']> };

export function isApproved(request: SupportRequest): request is ApprovedRequest {
  return request.approval !== undefined;
}
