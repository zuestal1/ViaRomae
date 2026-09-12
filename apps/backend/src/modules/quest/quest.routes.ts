/**
 * Quest Routes – Epic 4
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Endpoints:
 *   GET  /api/v1/quests              → active QuestRuns for the team
 *   GET  /api/v1/quests/available    → discoverable quests in proximity
 *   POST /api/v1/quests/accept       → accept a quest (slot ≤ 3)
 *   GET  /api/v1/quests/runs/:runId  → single QuestRun detail
 *   POST /api/v1/quests/runs/:runId/steps/:stepId/reach   → REACH_LOCATION
 *   POST /api/v1/quests/runs/:runId/steps/:stepId/answer  → ANSWER_QUESTION/SOLVE_PUZZLE
 *   POST /api/v1/quests/runs/:runId/complete              → COMPLETE quest
 *
 * Auth: JWT via `onRequest: [server.authenticate]`
 * accountId is extracted from request.user.sub (standard JWT subject claim).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getActiveRuns,
  getAvailableQuests,
  getQuestMapLocations,
  acceptQuest,
  validateReachLocation,
  submitAnswer,
  completeQuest,
  getSingleRun,
  deliverQuestItem,
  performQuestAction,
  startQuestTimer,
  engageEnemy,
} from "./quest.service.js";
import { db } from "../../db/client.js";
import { players } from "../../db/schema/player.js";
import { eq } from "drizzle-orm";
import { requireActiveEvent } from "../gm/event-runtime.service.js";

// ── Zod request schemas ───────────────────────────────────────────────────────

const AcceptBodySchema = z.object({
  questDefinitionId: z.string().uuid(),
  dialogueOptionId: z.string().min(1).optional(),
});

const ReachBodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().positive().max(500),
});

const AnswerBodySchema = z.object({
  answer: z.string().min(1).max(512),
  requireAllMembersOnline: z.boolean().optional().default(true),
});
const ActionBodySchema = z.object({ optionId: z.string().min(1).optional() });

// ── Internal helper ───────────────────────────────────────────────────────────

async function resolveTeamId(accountId: string): Promise<string> {
  const [player] = await db
    .select({ teamId: players.teamId })
    .from(players)
    .where(eq(players.accountId, accountId));

  if (!player) {
    const err = new Error(
      "No player record found for this account.",
    ) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  return player.teamId;
}

// ── Route plugin ─────────────────────────────────────────────────────────────

export async function questRoutes(server: FastifyInstance): Promise<void> {
  server.addHook("preHandler", async (request) => {
    if (request.method !== "GET") await requireActiveEvent();
  });

  // ── GET /api/v1/quests ─────────────────────────────────────────────────────
  server.get(
    "/",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const teamId = await resolveTeamId(accountId);
      const runs = await getActiveRuns(teamId);
      return reply.send({ runs });
    },
  );

  // ── GET /api/v1/quests/available ───────────────────────────────────────────
  server.get(
    "/available",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      request.log.info({ accountId }, 'GET /available - accountId from JWT');
      
      const teamId = await resolveTeamId(accountId);
      request.log.info({ teamId }, 'GET /available - resolved teamId');
      
      const quests = await getAvailableQuests(teamId);
      request.log.info({ questCount: quests.length, quests }, 'GET /available - quests from service');
      
      return reply.send({ quests });
    },
  );

  // ── GET /api/v1/quests/map-locations ──────────────────────────────────────
  // Returns all quest start locations (with lat/lng) for the map view when
  // the team has no active quests.
  server.get(
    "/map-locations",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const teamId = await resolveTeamId(accountId);
      const locations = await getQuestMapLocations(teamId);
      return reply.send({ locations });
    },
  );

  // ── POST /api/v1/quests/accept ─────────────────────────────────────────────
  server.post(
    "/runs/:runId/steps/:stepId/action",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const { runId, stepId } = request.params as { runId: string; stepId: string };
      const body = ActionBodySchema.parse(request.body ?? {});
      return reply.send(await performQuestAction({ accountId, questRunId: runId, stepId, ...(body.optionId ? { optionId: body.optionId } : {}), wsHub: server.wsHub }));
    },
  );

  server.post(
    "/runs/:runId/timers/:timerId/start",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const { runId, timerId } = request.params as { runId: string; timerId: string };
      return reply.send({ run: await startQuestTimer({ accountId, questRunId: runId, timerId }) });
    },
  );

  server.post(
    "/accept",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const body = AcceptBodySchema.safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          message: "Invalid request body.",
          errors: body.error.flatten(),
        });
      }

      const { run, alreadyActive } = await acceptQuest({
        accountId,
        questDefinitionId: body.data.questDefinitionId,
        wsHub: server.wsHub,
        ...(body.data.dialogueOptionId ? { dialogueOptionId: body.data.dialogueOptionId } : {}),
      });

      return reply.status(alreadyActive ? 200 : 201).send({ run, alreadyActive });
    },
  );
  server.post("/runs/:runId/steps/:stepId/item",{onRequest:[server.authenticate]},async(request,reply)=>{
    const body=z.object({itemInstanceId:z.string().uuid()}).safeParse(request.body);
    if(!body.success)return reply.status(400).send({message:"Invalid body"});
    const {sub}=request.user as {sub:string};const {runId,stepId}=request.params as {runId:string;stepId:string};
    try{return reply.send(await deliverQuestItem({accountId:sub,questRunId:runId,stepId,itemInstanceId:body.data.itemInstanceId,wsHub:server.wsHub}));}
    catch(error){const e=error as Error&{statusCode?:number};return reply.status(e.statusCode??500).send({message:e.message});}
  });

  // ── GET /api/v1/quests/runs/:runId ─────────────────────────────────────────
  server.get(
    "/runs/:runId",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const { runId } = request.params as { runId: string };
      const teamId = await resolveTeamId(accountId);
      const run = await getSingleRun(runId, teamId);

      if (!run) {
        return reply.status(404).send({ message: "QuestRun not found." });
      }

      return reply.send({ run });
    },
  );

  // ── POST /api/v1/quests/runs/:runId/steps/:stepId/reach ───────────────────
  server.post(
    "/runs/:runId/steps/:stepId/reach",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const { runId, stepId } = request.params as {
        runId: string;
        stepId: string;
      };
      const body = ReachBodySchema.safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          message: "Invalid request body.",
          errors: body.error.flatten(),
        });
      }

      const result = await validateReachLocation({
        accountId,
        questRunId: runId,
        stepId,
        lat: body.data.lat,
        lng: body.data.lng,
        accuracy: body.data.accuracy,
        wsHub: server.wsHub,
      });

      // Always return 200 – the StepResult.status field ("COMPLETED" | "FAILED")
      // tells the client what happened. 422 is reserved for actual server errors,
      // not for "player is still too far away" which is normal game feedback.
      return reply.status(200).send(result);
    },
  );

  // ── POST /api/v1/quests/runs/:runId/steps/:stepId/answer ──────────────────
  server.post(
    "/runs/:runId/steps/:stepId/answer",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const { runId, stepId } = request.params as {
        runId: string;
        stepId: string;
      };
      const body = AnswerBodySchema.safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          message: "Invalid request body.",
          errors: body.error.flatten(),
        });
      }

      const result = await submitAnswer({
        accountId,
        questRunId: runId,
        stepId,
        answer: body.data.answer,
        wsHub: server.wsHub,
        requireAllMembersOnline: body.data.requireAllMembersOnline,
      });

      // Same as /reach: always 200, use StepResult.status to distinguish outcomes.
      return reply.status(200).send(result);
    },
  );

  // ── POST /api/v1/quests/runs/:runId/steps/:stepId/engage ─────────────────
  // Manually start PvE combat for a DEFEAT_ENEMY step (button-based trigger).
  server.post(
    "/runs/:runId/steps/:stepId/engage",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const { runId, stepId } = request.params as { runId: string; stepId: string };

      try {
        const result = await engageEnemy({
          accountId,
          questRunId: runId,
          stepId,
          wsHub: server.wsHub,
        });
        return reply.status(200).send(result);
      } catch (err) {
        const statusCode = (err as Error & { statusCode?: number }).statusCode ?? 500;
        return reply.status(statusCode).send({ message: (err as Error).message });
      }
    },
  );

  // ── POST /api/v1/quests/runs/:runId/complete ──────────────────────────────
  server.post(
    "/runs/:runId/complete",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const { runId } = request.params as { runId: string };

      const granted = await completeQuest({
        accountId,
        questRunId: runId,
        wsHub: server.wsHub,
      });

      return reply.send({
        questRunId: runId,
        glory: granted.glory,
        denarii: granted.denarii,
        items: granted.items,
        itemsSkipped: granted.itemsSkipped,
      });
    },
  );
}
