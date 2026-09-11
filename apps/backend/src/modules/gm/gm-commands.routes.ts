/**
 * GM Commands Routes – Epic 9
 * Endpoints for GM administrative commands.
 */

import type { FastifyPluginAsync } from "fastify";
import { GMCommandService } from "./gm-commands.service.js";
import {
  CreatePlayerAccountBodySchema,
  ResetQuestBodySchema,
  OverrideHPBodySchema,
  OverrideLocationBodySchema,
  CorrectCurrencyBodySchema,
} from "@jlw/contracts";
import { accounts } from "../../db/schema/account.js";
import { players, teams } from "../../db/schema/player.js";
import { db } from "../../db/client.js";
import { hashAccessCode } from "../auth/auth.service.js";
import { asc, eq } from "drizzle-orm";

export const gmCommandsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", fastify.authorizeGM);
  const service = new GMCommandService(fastify.log);

  fastify.get("/accounts/teams", async () => db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(teams.name)));

  fastify.post("/accounts/players", async (request, reply) => {
    const body = CreatePlayerAccountBodySchema.parse(request.body);
    const result = await db.transaction(async (tx) => {
      let team: typeof teams.$inferSelect | undefined;
      if (body.teamId) [team] = await tx.select().from(teams).where(eq(teams.id, body.teamId)).limit(1);
      else [team] = await tx.insert(teams).values({ name: body.newTeamName! }).returning();
      if (!team) throw Object.assign(new Error("Team nicht gefunden."), { statusCode: 404 });
      const [account] = await tx.insert(accounts).values({
        username: body.username,
        accessCodeHash: await hashAccessCode(body.accessCode),
        role: "PLAYER",
      }).returning();
      const [player] = await tx.insert(players).values({
        accountId: account!.id, teamId: team.id,
        playerName: body.playerName ?? body.username,
      }).returning();
      return { account: { id: account!.id, username: account!.username, role: account!.role }, player: { id: player!.id, teamId: team.id, playerName: player!.playerName! }, team: { id: team.id, name: team.name } };
    });
    return reply.status(201).send(result);
  });

  // ── POST /api/v1/gm/commands/quest-reset ────────────────────────────────────
  fastify.post("/commands/quest-reset", async (request, reply) => {
    const actorId = request.user.accountId!;
    const { questRunId } = ResetQuestBodySchema.parse(request.body);

    const result = await service.resetQuest(actorId, questRunId);
    return reply.send(result);
  });

  // ── POST /api/v1/gm/commands/hp-override ────────────────────────────────────
  fastify.post("/commands/hp-override", async (request, reply) => {
    const actorId = request.user.accountId!;
    const { teamId, newHP } = OverrideHPBodySchema.parse(request.body);

    const result = await service.overrideHP(actorId, teamId, newHP);
    return reply.send(result);
  });

  // ── POST /api/v1/gm/commands/location-override ──────────────────────────────
  fastify.post("/commands/location-override", async (request, reply) => {
    const actorId = request.user.accountId!;
    const { playerId, lat, lng } = OverrideLocationBodySchema.parse(request.body);

    const result = await service.overrideLocation(actorId, playerId, lat, lng);
    return reply.send(result);
  });

  // ── POST /api/v1/gm/commands/currency-correction ────────────────────────────
  fastify.post("/commands/currency-correction", async (request, reply) => {
    const actorId = request.user.accountId!;
    const { teamId, currencyType, amount, reason } =
      CorrectCurrencyBodySchema.parse(request.body);

    const result = await service.correctCurrency(
      actorId,
      teamId,
      currencyType,
      amount,
      reason,
    );
    return reply.send(result);
  });

  // ── GET /api/v1/gm/audit-log ────────────────────────────────────────────────
  fastify.get(
    "/audit-log",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "number", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "number", minimum: 0, default: 0 },
            actorId: { type: "string", format: "uuid" },
            action: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { limit, offset, actorId, action } = request.query as {
        limit?: number;
        offset?: number;
        actorId?: string;
        action?: string;
      };

      const params: Parameters<typeof service.getAuditLog>[0] = {};
      if (limit !== undefined) params.limit = limit;
      if (offset !== undefined) params.offset = offset;
      if (actorId !== undefined) params.actorId = actorId;
      if (action !== undefined) params.action = action as any;

      const logs = await service.getAuditLog(params);

      return reply.send(logs);
    },
  );
};
