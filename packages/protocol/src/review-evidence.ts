import { z } from "zod";

export const MAX_REVIEW_EVIDENCE_BYTES = 400 * 1024;
const patch = z
  .string()
  .min(1)
  .max(MAX_REVIEW_EVIDENCE_BYTES)
  .refine(
    (value) =>
      !value.includes("\0") &&
      new TextEncoder().encode(value).byteLength <= MAX_REVIEW_EVIDENCE_BYTES,
    "Review evidence must be a text patch of at most 400 KiB.",
  );
export const PutReviewEvidenceBodySchema = z.object({
  leaseVersion: z.number().int().positive(),
  patch,
});
export type PutReviewEvidenceBody = z.infer<typeof PutReviewEvidenceBodySchema>;
export const ReviewEvidenceResponseSchema = PutReviewEvidenceBodySchema.extend({
  ok: z.literal(true),
});
export type ReviewEvidenceResponse = z.infer<typeof ReviewEvidenceResponseSchema>;
