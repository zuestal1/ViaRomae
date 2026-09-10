import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  assignLoot,
  listInventory,
  equipItem,
  unequipItem,
  computeEquippedStats,
  getItemCount,
} from "../economy/inventory.service.js";
import { db } from "../../db/client.js";

const LootBody = z.object({
  idempotencyKey: z.string().uuid(),
  targetType: z.enum(["PLAYER", "TEAM"]),
  targetId: z.string().uuid(),
  items: z
    .array(z.object({ defKey: z.string(), quantity: z.number().int().min(1) }))
    .optional()
    .default([]),
  currencies: z
    .array(
      z.object({
        currencyType: z.enum(["DENARII", "FAME"]),
        amount: z.number().int(),
        playerId: z.string().uuid().optional(),
      }),
    )
    .optional()
    .default([]),
});

const EquipBody = z.object({ itemInstanceId: z.string().uuid() });
const UnequipBody = z.object({ itemInstanceId: z.string().uuid() });

function mapItem(row: Record<string, unknown>) {
  const statsRaw = row["stats"];
  let stats: Record<string, number> = {};
  if (statsRaw && typeof statsRaw === "object" && !Array.isArray(statsRaw)) {
    for (const [k, v] of Object.entries(statsRaw as Record<string, unknown>)) {
      if (typeof v === "number") stats[k] = v;
    }
  } else if (typeof statsRaw === "string") {
    try {
      stats = JSON.parse(statsRaw) as Record<string, number>;
    } catch {
      stats = {};
    }
  }
  return {
    id: String(row["id"]),
    definitionId: String(row["definition_id"]),
    name: row["name"] != null ? String(row["name"]) : undefined,
    ownerType: row["owner_type"] as "PLAYER" | "TEAM",
    ownerId: String(row["owner_id"]),
    quantity: Number(row["quantity"] ?? 1),
    category: row["definition_category"] ?? row["category"],
    slot: row["slot"] ?? null,
    isEquipped: Boolean(row["is_equipped"]),
    isBound: Boolean(row["is_bound"]),
    stats,
    effectiveStats: row["effective_stats"],
    rarity: row["rarity"] ?? "N",
    allowedClasses: row["allowed_classes"] ?? [],
    canEquip: Boolean(row["can_equip"]),
    unusableReason: row["unusable_reason"] ?? null,
    stackable: Boolean(row["stackable"]),
  };
}

async function resolvePlayer(accountId: string) {
  const playerRow = await db.execute(sql`
    SELECT p.id AS player_id, p.team_id
    FROM player p
    WHERE p.account_id = ${accountId}::uuid
  `);
  return (playerRow.rows as { player_id: string; team_id: string }[])[0] ?? null;
}

export async function inventoryRoutes(server: FastifyInstance): Promise<void> {
  server.post("/loot", { onRequest: [server.authenticate] }, async (request, reply) => {
    const body = LootBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ message: "Invalid body", errors: body.error.flatten() });
    }
    try {
      const res = await assignLoot({
        idempotencyKey: body.data.idempotencyKey,
        ownerType: body.data.targetType,
        ownerId: body.data.targetId,
        items: body.data.items,
        currencies: body.data.currencies.map((c) => ({
          currencyType: c.currencyType,
          amount: c.amount,
          playerId: c.playerId ?? null,
        })),
      });
      return reply.status(201).send(res);
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ message: e.message });
    }
  });

  server.get("/", { onRequest: [server.authenticate] }, async (request, reply) => {
    const { sub: accountId } = request.user as { sub: string };
    const owner = (request.query as { owner?: string }).owner === "team" ? "team" : "player";
    const player = await resolvePlayer(accountId);
    if (!player) return reply.status(404).send({ message: "Player not found" });
    const rows = await listInventory(
      owner === "team" ? "TEAM" : "PLAYER",
      owner === "team" ? player.team_id : player.player_id,
    );
    return reply.send({ items: (rows as Record<string, unknown>[]).map(mapItem) });
  });

  server.post("/equip", { onRequest: [server.authenticate] }, async (request, reply) => {
    const body = EquipBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ message: "Invalid body", errors: body.error.flatten() });
    }
    const { sub: accountId } = request.user as { sub: string };
    try {
      return reply.send(await equipItem(accountId, body.data.itemInstanceId));
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ message: e.message });
    }
  });

  server.post("/unequip", { onRequest: [server.authenticate] }, async (request, reply) => {
    const body = UnequipBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ message: "Invalid body", errors: body.error.flatten() });
    }
    const { sub: accountId } = request.user as { sub: string };
    try {
      return reply.send(await unequipItem(accountId, body.data.itemInstanceId));
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      return reply.status(e.statusCode ?? 500).send({ message: e.message });
    }
  });

  server.get("/stats", { onRequest: [server.authenticate] }, async (request, reply) => {
    const { sub: accountId } = request.user as { sub: string };
    const player = await resolvePlayer(accountId);
    if (!player) return reply.status(404).send({ message: "Player not found" });
    const stats = await computeEquippedStats("PLAYER", player.player_id);
    const playerCount = await getItemCount("PLAYER", player.player_id);
    const teamCount = await getItemCount("TEAM", player.team_id);
    return reply.send({ stats, playerCount, teamCount });
  });
}
