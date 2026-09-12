/**
 * Combat Routes (Epic 6)
 */
import type { FastifyInstance } from "fastify";
import { SubmitActionBodySchema, SubmitReviveBodySchema } from "@jlw/contracts";
import { z } from "zod";
import { db } from "../../db/client.js";
import { players } from "../../db/schema/player.js";
import { eq } from "drizzle-orm";
import {
  getCombatInstance,
  submitCombatAction,
  lockAndResolveRound,
  getActiveCombatForTeam,
  startPvPChallenge,
  submitCombatRevive,
} from "./combat.service.js";
import { requireActiveEvent } from "../gm/event-runtime.service.js";

const submitActionSchema = z.object({
  actionType: z.enum(["ATTACK", "SKILL"]),
  targetId: z.string().uuid().optional(),
  targetIds: z.array(z.string().uuid()).optional(),
  abilityId: z.string().optional(),
  idempotencyKey: z.string().uuid(),
});

export async function combatRoutes(server: FastifyInstance): Promise<void> {
  server.post("/pvp/challenge", { preHandler: [server.authenticate] }, async (request, reply) => {
    await requireActiveEvent();
    const { sub: accountId } = request.user as { sub: string };
    const body = z.object({ defenderTeamId: z.string().uuid() }).parse(request.body);
    const [player] = await db.select({ teamId: players.teamId }).from(players).where(eq(players.accountId, accountId));
    if (!player) return reply.status(404).send({ error: "Player not found" });
    try {
      return reply.send(await startPvPChallenge({ attackerTeamId: player.teamId,
        defenderTeamId: body.defenderTeamId, wsHub: server.wsHub }));
    } catch (error) {
      server.log.warn(error);
      return reply.status(409).send({ error: error instanceof Error ? error.message : "PvP challenge rejected" });
    }
  });

  server.post("/:id/revive", { preHandler: [server.authenticate] }, async (request, reply) => {
    await requireActiveEvent();
    const { sub: accountId } = request.user as { sub: string };
    const body = SubmitReviveBodySchema.parse(request.body);
    const [player] = await db.select({ id: players.id }).from(players).where(eq(players.accountId, accountId));
    if (!player) return reply.status(404).send({ error: "Player not found" });
    try {
      return reply.send(await submitCombatRevive({ combatId: (request.params as { id: string }).id,
        playerId: player.id, ...body }));
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : "Revive rejected" });
    }
  });

  /** GET /api/v1/combat/:id – get combat instance state */
  server.get(
    "/:id",
    {
      preHandler: [server.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const combat = await getCombatInstance(id);
        return reply.send(combat);
      } catch (err) {
        server.log.error(err);
        return reply.status(404).send({ error: "Combat not found" });
      }
    }
  );

  /** GET /api/v1/combat/team/active – get active combat for authenticated player's team */
  server.get(
    "/team/active",
    {
      preHandler: [server.authenticate],
    },
    async (request, reply) => {
      await requireActiveEvent();
      const { sub: accountId } = request.user as { sub: string };

      // Resolve teamId from accountId
      const [player] = await db
        .select({ teamId: players.teamId })
        .from(players)
        .where(eq(players.accountId, accountId));

      if (!player) {
        return reply.status(404).send({ error: "Player not found" });
      }
      const { teamId } = player;

      try {
        const combat = await getActiveCombatForTeam(teamId);
        if (!combat) {
          return reply.status(404).send({ error: "No active combat" });
        }
        return reply.send(combat);
      } catch (err) {
        server.log.error(err);
        return reply.status(500).send({ error: "Failed to get active combat" });
      }
    }
  );

  /** POST /api/v1/combat/:id/action – submit round action */
  server.post(
    "/:id/action",
    {
      preHandler: [server.authenticate],
    },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };

      // Resolve playerId from accountId
      const [player] = await db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.accountId, accountId));

      if (!player) {
        return reply.status(404).send({ error: "Player not found" });
      }
      const playerId = player.id;

      const { id } = request.params as { id: string };

      try {
        const body = SubmitActionBodySchema.parse(request.body);
        const isAbility = "abilityId" in body;

        const action = await submitCombatAction({
          combatId: id,
          playerId,
          roundNumber: body.roundNumber,
          actionType: isAbility ? "SKILL" : body.actionType,
          abilityId: isAbility ? body.abilityId : undefined,
          targetId: body.targetId,
          idempotencyKey: body.idempotencyKey,
          wsHub: server.wsHub,
        });

        return reply.send(action);
      } catch (err) {
        server.log.error(err);
        return reply.status(400).send({ error: "Invalid action" });
      }
    }
  );

  /** POST /api/v1/combat/:id/lock – manually lock and resolve round (GM only) */
  server.post(
    "/:id/lock",
    {
      preHandler: [server.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { role } = request.user as { role: string };

      if (role !== "GM") {
        return reply.status(403).send({ error: "Forbidden" });
      }

      try {
        const logs = await lockAndResolveRound(id);
        return reply.send({ logs });
      } catch (err) {
        server.log.error(err);
        return reply.status(500).send({ error: "Failed to lock round" });
      }
    }
  );
}
