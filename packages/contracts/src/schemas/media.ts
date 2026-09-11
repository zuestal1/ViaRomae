import { z } from "zod";

export const MediaStatusSchema = z.enum([
  "UPLOADING",
  "RECEIVED",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
]);
export type MediaStatus = z.infer<typeof MediaStatusSchema>;

export const MediaSubmissionSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  questRunId: z.string().uuid(),
  stepId: z.string(),
  objectKey: z.string(),
  mimeType: z.string(),
  fileSizeBytes: z.number().int().nonnegative(),
  previewUrl: z.string().url().optional(),
  status: MediaStatusSchema,
  submittedAt: z.string().datetime(),
  /** Latest GM feedback. Present after a review decision. */
  reviewScore: z.number().int().min(0).max(10).nullable().optional(),
  reviewReason: z.string().nullable().optional(),
  reviewedAt: z.string().datetime().nullable().optional(),
});
export type MediaSubmission = z.infer<typeof MediaSubmissionSchema>;

export const PresignedUploadResponseSchema = z.object({
  submissionId: z.string().uuid(),
  uploadUrl: z.string().url(),
  objectKey: z.string(),
  expiresIn: z.number().int(),
});
export type PresignedUploadResponse = z.infer<
  typeof PresignedUploadResponseSchema
>;

// ── Request/Response Schemas ──────────────────────────────────────────────────

export const RequestUploadUrlBodySchema = z.object({
  questRunId: z.string().uuid(),
  stepId: z.string().min(1).max(64),
  fileType: z.enum(["image/jpeg", "image/png", "video/mp4", "video/quicktime"]),
  fileSizeBytes: z.number().int().positive().max(50 * 1024 * 1024), // 50 MB max
});
export type RequestUploadUrlBody = z.infer<typeof RequestUploadUrlBodySchema>;

export const SubmitReviewBodySchema = z.object({
  score: z.number().int().min(0).max(10),
  criteria: z.object({
    taskLocation: z.number().int().min(0).max(2),
    storyRoles: z.number().int().min(0).max(3),
    creativity: z.number().int().min(0).max(3),
    execution: z.number().int().min(0).max(2),
  }),
  reason: z.string().optional(),
}).superRefine((value, ctx) => {
  const total = value.criteria.taskLocation + value.criteria.storyRoles + value.criteria.creativity + value.criteria.execution;
  if (total !== value.score) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["score"], message: "Score must equal the GDD rubric total." });
});
export type SubmitReviewBody = z.infer<typeof SubmitReviewBodySchema>;

export const ReviewDecisionSchema = z.object({
  id: z.string().uuid(),
  submissionId: z.string().uuid(),
  reviewerId: z.string().uuid(),
  score: z.number(),
  criteria: z.object({ taskLocation: z.number(), storyRoles: z.number(), creativity: z.number(), execution: z.number() }).nullable().optional(),
  reason: z.string().optional(),
  decidedAt: z.string().datetime(),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

// ── WebSocket Events ──────────────────────────────────────────────────────────

export const MediaUploadCompletedEventSchema = z.object({
  event: z.literal("media:upload_completed"),
  data: z.object({
    submissionId: z.string().uuid(),
    questRunId: z.string().uuid(),
  }),
});
export type MediaUploadCompletedEvent = z.infer<typeof MediaUploadCompletedEventSchema>;

export const MediaReviewedEventSchema = z.object({
  event: z.literal("media:reviewed"),
  data: z.object({
    submissionId: z.string().uuid(),
    questRunId: z.string().uuid(),
    status: MediaStatusSchema,
    score: z.number(),
  }),
});
export type MediaReviewedEvent = z.infer<typeof MediaReviewedEventSchema>;
