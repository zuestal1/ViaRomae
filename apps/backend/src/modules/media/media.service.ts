/**
 * Media Service – Epic 8 Media Quests
 * Handles photo/video uploads, review workflow, and ledger integration.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../../db/client.js";
import { mediaSubmissions, reviewDecisions } from "../../db/schema/media.js";
import { objectiveProgress, questRuns, questSteps } from "../../db/schema/quest.js";
import { S3Service } from "./s3.service.js";
import { eq, and, desc } from "drizzle-orm";
import type {
  PresignedUploadResponse,
  MediaSubmission,
  ReviewDecision,
} from "@jlw/contracts";

export class MediaService {
  private s3: S3Service;
  private logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger.child({ module: "MediaService" });
    this.s3 = new S3Service(logger);
  }

  /**
   * Request a pre-signed S3 upload URL for a team's quest media submission.
   */
  async requestUploadUrl(
    teamId: string,
    questRunId: string,
    stepId: string,
    fileType: string,
    fileSizeBytes: number,
  ): Promise<PresignedUploadResponse> {
    // Validate that the QuestRun exists and belongs to this team
    const [questRun] = await db
      .select()
      .from(questRuns)
      .where(and(eq(questRuns.id, questRunId), eq(questRuns.teamId, teamId)))
      .limit(1);

    if (!questRun) {
      throw new Error("Quest run not found or does not belong to team");
    }

    if (questRun.state !== "ACTIVE") {
      throw new Error("A media submission is already awaiting review");
    }

    const [step] = await db.select().from(questSteps).where(and(
      eq(questSteps.questDefinitionId, questRun.questDefinitionId),
      eq(questSteps.stepId, stepId),
      eq(questSteps.stepActionType, "UPLOAD_MEDIA"),
      eq(questSteps.flowPhase, "OBJECTIVE"),
    )).limit(1);
    if (!step) throw new Error("UPLOAD_MEDIA step not found for this quest");

    const orderedSteps = await db.select({ step: questSteps, progress: objectiveProgress })
      .from(questSteps)
      .leftJoin(objectiveProgress, and(
        eq(objectiveProgress.questRunId, questRunId),
        eq(objectiveProgress.objectiveId, questSteps.stepId),
      ))
      .where(and(
        eq(questSteps.questDefinitionId, questRun.questDefinitionId),
        eq(questSteps.flowPhase, "OBJECTIVE"),
        eq(questSteps.required, true),
      ))
      .orderBy(questSteps.sequence);
    const currentStep = orderedSteps.find(({ progress }) => progress?.status !== "COMPLETED");
    if (currentStep?.step.stepId !== stepId) {
      throw new Error("This media step is not the quest's current objective");
    }

    // Generate pre-signed URL
    const { uploadUrl, objectKey, expiresIn } = await this.s3.generatePresignedUploadUrl(
      teamId,
      questRunId,
      fileType,
      fileSizeBytes,
    );

    // Create MediaSubmission record (status: UPLOADING)
    const [submission] = await db
      .insert(mediaSubmissions)
      .values({
        teamId,
        questRunId,
        stepId,
        objectKey,
        status: "UPLOADING",
      })
      .returning();

    this.logger.info(
      { submissionId: submission!.id, teamId, questRunId },
      "Created media submission (UPLOADING)",
    );

    return { submissionId: submission!.id, uploadUrl, objectKey, expiresIn };
  }

  /**
   * Confirm that an upload is complete (called by S3 webhook or client).
   * Transitions MediaSubmission → RECEIVED and QuestRun → PENDING_REVIEW.
   */
  async confirmUploadComplete(objectKey: string, teamId: string): Promise<MediaSubmission> {
    const [submission] = await db
      .select()
      .from(mediaSubmissions)
      .where(and(eq(mediaSubmissions.objectKey, objectKey), eq(mediaSubmissions.teamId, teamId)))
      .limit(1);

    if (!submission) {
      throw new Error("Media submission not found for object key");
    }

    if (submission.status !== "UPLOADING") {
      this.logger.warn(
        { submissionId: submission.id, status: submission.status },
        "Upload already confirmed",
      );
      return {
        ...submission,
        submittedAt: submission.submittedAt.toISOString(),
      };
    }

    // Update submission → RECEIVED
    const [updated] = await db
      .update(mediaSubmissions)
      .set({ status: "RECEIVED" })
      .where(eq(mediaSubmissions.id, submission.id))
      .returning();

    // Update QuestRun → PENDING_REVIEW
    await db
      .update(questRuns)
      .set({ state: "PENDING_REVIEW" })
      .where(eq(questRuns.id, submission.questRunId));

    this.logger.info(
      { submissionId: submission.id, questRunId: submission.questRunId },
      "Upload confirmed → PENDING_REVIEW",
    );

    return {
      ...updated!,
      submittedAt: updated!.submittedAt.toISOString(),
    };
  }

  /**
   * Submit a GM review decision (Epic 9).
   * Approves/rejects the submission and posts LedgerEntry based on score.
   * Also marks the UPLOAD_MEDIA quest step as completed if approved.
   */
  async submitReview(
    submissionId: string,
    reviewerId: string,
    score: number,
    reason?: string,
  ): Promise<Omit<typeof reviewDecisions.$inferSelect, "decidedAt"> & { decidedAt: string }> {
    const decision = await db.transaction(async (tx) => {
      const [submission] = await tx.select().from(mediaSubmissions)
        .where(eq(mediaSubmissions.id, submissionId)).limit(1);
      if (!submission) throw new Error("Media submission not found");

      const [existing] = await tx.select().from(reviewDecisions)
        .where(eq(reviewDecisions.submissionId, submissionId)).limit(1);
      if (existing) return existing;

      const newStatus = score >= 5 ? "APPROVED" : "REJECTED";
      const cleanReason = reason?.trim();
      if (newStatus === "REJECTED" && !cleanReason) {
        throw new Error("Rejected submissions require GM feedback");
      }

      const [created] = await tx.insert(reviewDecisions).values({
        submissionId, reviewerId, score, reason: cleanReason,
      }).onConflictDoNothing().returning();
      if (!created) {
        const [concurrentDecision] = await tx.select().from(reviewDecisions)
          .where(eq(reviewDecisions.submissionId, submissionId)).limit(1);
        if (!concurrentDecision) throw new Error("Review decision could not be persisted");
        return concurrentDecision;
      }
      await tx.update(mediaSubmissions).set({ status: newStatus })
        .where(eq(mediaSubmissions.id, submissionId));

      if (newStatus === "APPROVED") {
        await tx.insert(objectiveProgress).values({
          questRunId: submission.questRunId,
          objectiveId: submission.stepId,
          status: "COMPLETED",
          progressCount: 1,
        }).onConflictDoUpdate({
          target: [objectiveProgress.questRunId, objectiveProgress.objectiveId],
          set: { status: "COMPLETED", progressCount: 1 },
        });
      }

      // Completion and rewards remain behind the normal idempotent quest-complete
      // endpoint; returning ACTIVE exposes either the next step or completion UI.
      await tx.update(questRuns).set({ state: "ACTIVE" })
        .where(and(eq(questRuns.id, submission.questRunId), eq(questRuns.state, "PENDING_REVIEW")));
      return created;
    });

    const [submission] = await db.select().from(mediaSubmissions)
      .where(eq(mediaSubmissions.id, submissionId)).limit(1);
    if (submission && decision.score >= 5 && decision.score > 0) {
      const { appendLedgerEntry } = await import("../economy/ledger.service.js");
      await appendLedgerEntry({
        idempotencyKey: `media-review:${submissionId}:fame`, teamId: submission.teamId,
        currencyType: "FAME", amount: decision.score, source: "ADMIN",
      });
      if (decision.score >= 7) await appendLedgerEntry({
        idempotencyKey: `media-review:${submissionId}:denarii`, teamId: submission.teamId,
        currencyType: "DENARII", amount: (decision.score - 6) * 10, source: "ADMIN",
      });
    }

    this.logger.info({ submissionId, reviewerId, score }, "Media review submitted");
    const result = { ...decision, decidedAt: decision.decidedAt.toISOString() };
    return decision.reason ? { ...result, reason: decision.reason } : result;
  }

  /**
   * Get all submissions for a team's quest run.
   */
  async getSubmissionById(submissionId: string): Promise<MediaSubmission | null> {
    const [submission] = await db.select().from(mediaSubmissions)
      .where(eq(mediaSubmissions.id, submissionId)).limit(1);
    return submission ? { ...submission, submittedAt: submission.submittedAt.toISOString() } : null;
  }

  async getSubmissionsByQuestRun(questRunId: string, teamId?: string): Promise<MediaSubmission[]> {
    const rows = await db.select({ submission: mediaSubmissions, decision: reviewDecisions })
      .from(mediaSubmissions)
      .leftJoin(reviewDecisions, eq(reviewDecisions.submissionId, mediaSubmissions.id))
      .where(teamId
        ? and(eq(mediaSubmissions.questRunId, questRunId), eq(mediaSubmissions.teamId, teamId))
        : eq(mediaSubmissions.questRunId, questRunId))
      .orderBy(desc(mediaSubmissions.submittedAt));
    return rows.map(({ submission, decision }) => ({
      ...submission,
      submittedAt: submission.submittedAt.toISOString(),
      reviewScore: decision?.score ?? null,
      reviewReason: decision?.reason ?? null,
      reviewedAt: decision?.decidedAt.toISOString() ?? null,
    }));
  }

  /**
   * Get all pending submissions (for GM inbox, Epic 9).
   */
  async getPendingSubmissions(): Promise<MediaSubmission[]> {
    const rows = await db
      .select()
      .from(mediaSubmissions)
      .where(eq(mediaSubmissions.status, "RECEIVED"));
    
    return rows.map((r) => ({
      ...r,
      submittedAt: r.submittedAt.toISOString(),
    }));
  }
}
