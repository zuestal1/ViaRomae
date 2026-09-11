import type { FastifyInstance, FastifyRequest } from "fastify";
import { MediaService } from "./media.service.js";
import {
  RequestUploadUrlBodySchema,
  SubmitReviewBodySchema,
} from "@jlw/contracts";

export async function mediaRoutes(server: FastifyInstance): Promise<void> {
  const mediaService = new MediaService(server.log);

  /**
   * POST /api/v1/media/upload-url
   * Request a pre-signed S3 upload URL for media quest submission.
   */
  server.post<{
    Body: {
      questRunId: string;
      stepId: string;
      fileType: string;
      fileSizeBytes: number;
    };
  }>(
    "/upload-url",
    {
      preHandler: [server.authenticate],
    },
    async (request, reply) => {
      const body = RequestUploadUrlBodySchema.parse(request.body);
      const teamId = (request.user as { teamId: string }).teamId;

      if (!teamId) {
        return reply.status(400).send({ error: "User has no team" });
      }

      try {
        const result = await mediaService.requestUploadUrl(
          teamId,
          body.questRunId,
          body.stepId,
          body.fileType,
          body.fileSizeBytes,
        );
        return reply.status(200).send(result);
      } catch (err) {
        server.log.error(err, "Failed to generate upload URL");
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * POST /api/v1/media/confirm/:objectKey
   * Confirm that a media upload is complete (called by client after successful upload).
   * Transitions submission → RECEIVED and quest → PENDING_REVIEW.
   */
  server.post<{
    Params: { objectKey: string };
  }>(
    "/confirm/:objectKey",
    {
      preHandler: [server.authenticate],
    },
    async (request, reply) => {
      try {
        const submission = await mediaService.confirmUploadComplete(
          decodeURIComponent(request.params.objectKey),
          (request.user as { teamId: string }).teamId,
        );

        // Emit WebSocket event to team
        server.wsHub.sendToTeam(submission.teamId, {
          event: "media:upload_completed",
          data: {
            submissionId: submission.id,
            questRunId: submission.questRunId,
          },
        });

        return reply.status(200).send({ status: "confirmed", submission });
      } catch (err) {
        server.log.error(err, "Failed to confirm upload");
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * POST /api/v1/media/:id/review
   * GM submits a review decision (Epic 9).
   */
  server.post<{
    Params: { id: string };
    Body: { score: number; reason?: string };
  }>(
    "/:id/review",
    {
      preHandler: [server.authenticate],
    },
    async (request, reply) => {
      const body = SubmitReviewBodySchema.parse(request.body);
      const reviewerId = (request.user as { sub: string }).sub;
      const role = (request.user as { role?: string }).role;

      if (role !== "GM" && role !== "ADMIN") {
        return reply.status(403).send({ error: "Only GMs can review media" });
      }

      try {
        const decision = await mediaService.submitReview(
          request.params.id,
          reviewerId,
          body.score,
          body.reason,
        );

        // Get submission to emit event
        const submission = await mediaService.getSubmissionById(decision.submissionId);

        if (submission) {
          server.wsHub.sendToTeam(submission.teamId, {
            event: "media:reviewed",
            data: {
              submissionId: submission.id,
              questRunId: submission.questRunId,
              status: submission.status,
              score: body.score,
            },
          });
        }

        return reply.status(200).send({ decision });
      } catch (err) {
        server.log.error(err, "Failed to submit review");
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * GET /api/v1/media/pending
   * Get all pending media submissions (GM inbox, Epic 9).
   */
  server.get(
    "/pending",
    {
      preHandler: [server.authenticate],
    },
    async (request, reply) => {
      const role = (request.user as { role?: string }).role;

      if (role !== "GM" && role !== "ADMIN") {
        return reply.status(403).send({ error: "Only GMs can view pending media" });
      }

      const submissions = await mediaService.getPendingSubmissions();
      return reply.status(200).send({ submissions });
    },
  );

  /**
   * GET /api/v1/media/quest/:questRunId
   * Get all submissions for a quest run.
   */
  server.get<{
    Params: { questRunId: string };
  }>(
    "/quest/:questRunId",
    {
      preHandler: [server.authenticate],
    },
    async (request, reply) => {
      const submissions = await mediaService.getSubmissionsByQuestRun(
        request.params.questRunId,
        (request.user as { teamId: string }).teamId,
      );
      return reply.status(200).send({ submissions });
    },
  );
}
