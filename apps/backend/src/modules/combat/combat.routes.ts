/**
 * Combat Routes (Epic 6)
 */
import type { FastifyInstance } from "fastify";
import { SubmitActionBodySchema } from "@jlw/contracts";
import { db } from "../../db/client.js";
import { players } from "../../db/schema/player.js";
import { eq } from "drizzle-orm";
import {
  getCombatInstance,
  submitCombatAction,
  lockAndResolveRound,
  getActiveCombatForTeam,
} from "./combat.service.js";

export async function combatRoutes(server: FastifyInstance): Promise<void> {
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
          actionType: isAbility ? "SKILL" : body.actionType,
          abilityId: isAbility ? body.abilityId : undefined,
          targetId: body.targetId,
          idempotencyKey: body.idempotencyKey,
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
