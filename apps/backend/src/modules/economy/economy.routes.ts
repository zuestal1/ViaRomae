import type { FastifyInstance } from "fastify";
import { db } from "../../db/client.js";
import { sql, ne } from "drizzle-orm";
import { z } from "zod";
import {
  appendLedgerEntry,
  getTeamBalance,
} from "./ledger.service.js";
import {
  acceptTradeOffer,
  cancelTradeOffer,
  createTradeOffer,
  listTradeOffers,
  rejectTradeOffer,
} from "./trade.service.js";
import { computeEquippedStats, getItemCount } from "./inventory.service.js";
import { teams } from "../../db/schema/player.js";
import { requireActiveEvent } from "../gm/event-runtime.service.js";

const AppendLedgerBody = z.object({
  idempotencyKey: z.string().uuid(),
  currencyType: z.enum(["FAME", "DENARII"]),
  amount: z.number().int(),
  source: z.enum(["QUEST", "COMBAT", "TRADE", "STORE", "ADMIN"]),
  playerId: z.string().uuid().optional(),
});

const OfferSideBody = z.object({
  items: z
    .array(
      z.object({
        itemInstanceId: z.string().uuid(),
        quantity: z.number().int().min(1),
      }),
    )
    .optional()
    .default([]),
  denarii: z.number().int().min(0).optional().default(0),
});

const CreateOfferBody = OfferSideBody.extend({
  counterpartyTeamId: z.string().uuid(),
});

async function resolveTeamId(accountId: string): Promise<string> {
  const row = await db.execute(sql`
    SELECT p.team_id FROM player p WHERE p.account_id = ${accountId}::uuid
  `);
  const teamId = (row.rows as { team_id: string }[])[0]?.team_id;
  if (!teamId) {
    const err = new Error("Player not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  return teamId;
}

async function resolvePlayer(accountId: string): Promise<{
  playerId: string;
  teamId: string;
}> {
  const row = await db.execute(sql`
    SELECT p.id AS player_id, p.team_id
    FROM player p
    WHERE p.account_id = ${accountId}::uuid
  `);
  const player = (row.rows as { player_id: string; team_id: string }[])[0];
  if (!player) {
    const err = new Error("Player not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  return { playerId: player.player_id, teamId: player.team_id };
}

export async function economyRoutes(server: FastifyInstance): Promise<void> {
  server.get(
    "/summary",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const { playerId, teamId } = await resolvePlayer(accountId);
      const [fame, denarii, equippedStats, playerCount, teamCount] = await Promise.all([
        getTeamBalance(teamId, "FAME"),
        getTeamBalance(teamId, "DENARII"),
        computeEquippedStats("PLAYER", playerId),
        getItemCount("PLAYER", playerId),
        getItemCount("TEAM", teamId),
      ]);
      return reply.send({
        fame,
        denarii,
        equippedStats,
        playerCount,
        teamCount,
        playerLimit: 20,
        teamLimit: 40,
      });
    },
  );

  server.get(
    "/teams",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const { teamId } = await resolvePlayer(accountId);
      const rows = await db
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(ne(teams.id, teamId));
      return reply.send({ teams: rows });
    },
  );
  server.get(
    "/ledger",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const teamId = await resolveTeamId(accountId);
      const res = await db.execute(sql`
        SELECT * FROM ledger_entry
         WHERE team_id = ${teamId}::uuid
         ORDER BY created_at DESC
         LIMIT 200
      `);
      return reply.send({ entries: res.rows });
    },
  );

  server.post(
    "/ledger/append",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      if ((request.user as {role?:string}).role !== "GM") return reply.status(403).send({message:"GM role required"});
      const body = AppendLedgerBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ message: "Invalid body", errors: body.error.flatten() });
      }
      const { sub: accountId } = request.user as { sub: string };
      const teamId = await resolveTeamId(accountId);
      const row = await appendLedgerEntry({
        idempotencyKey: body.data.idempotencyKey,
        teamId,
        playerId: body.data.playerId ?? null,
        currencyType: body.data.currencyType,
        amount: body.data.amount,
        source: body.data.source,
      });
      return reply.status(201).send({ entry: row });
    },
  );

  server.get(
    "/trade/offers",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const { teamId } = await resolvePlayer(accountId);
      return reply.send(await listTradeOffers(teamId));
    },
  );

  server.post(
    "/trade/offers",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      await requireActiveEvent();
      const body = CreateOfferBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ message: "Invalid body", errors: body.error.flatten() });
      }
      const { sub: accountId } = request.user as { sub: string };
      const { teamId } = await resolvePlayer(accountId);
      try {
        const offer = await createTradeOffer({
          initiatorTeamId: teamId,
          counterpartyTeamId: body.data.counterpartyTeamId,
          side: { items: body.data.items, denarii: body.data.denarii },
        });
        return reply.status(201).send({ offer });
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number };
        return reply.status(e.statusCode ?? 500).send({ message: e.message });
      }
    },
  );

  server.post(
    "/trade/offers/:id/accept",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      await requireActiveEvent();
      const body = OfferSideBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ message: "Invalid body", errors: body.error.flatten() });
      }
      const { id } = request.params as { id: string };
      const { sub: accountId } = request.user as { sub: string };
      const { teamId } = await resolvePlayer(accountId);
      try {
        const offer = await acceptTradeOffer({
          offerId: id,
          teamId,
          counterSide: { items: body.data.items, denarii: body.data.denarii },
        });
        return reply.send({ offer });
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number };
        return reply.status(e.statusCode ?? 500).send({ message: e.message });
      }
    },
  );

  server.post(
    "/trade/offers/:id/reject",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      await requireActiveEvent();
      const { id } = request.params as { id: string };
      const { sub: accountId } = request.user as { sub: string };
      const { teamId } = await resolvePlayer(accountId);
      try {
        await rejectTradeOffer({ offerId: id, teamId });
        return reply.send({ ok: true });
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number };
        return reply.status(e.statusCode ?? 500).send({ message: e.message });
      }
    },
  );

  server.post(
    "/trade/offers/:id/cancel",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      await requireActiveEvent();
      const { id } = request.params as { id: string };
      const { sub: accountId } = request.user as { sub: string };
      const { teamId } = await resolvePlayer(accountId);
      try {
        await cancelTradeOffer({ offerId: id, teamId });
        return reply.send({ ok: true });
      } catch (err: unknown) {
        const e = err as Error & { statusCode?: number };
        return reply.status(e.statusCode ?? 500).send({ message: e.message });
      }
    },
  );

  server.post(
    "/trade",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      return reply.status(410).send({
        message: "One-way trade removed. Use POST /economy/trade/offers.",
      });
    },
  );
}
