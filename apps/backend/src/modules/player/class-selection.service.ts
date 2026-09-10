import { and, eq, ne, sql } from "drizzle-orm";
import type { SelectablePlayerClass } from "@jlw/contracts";
import { db } from "../../db/client.js";
import { players, teams } from "../../db/schema/player.js";
import { auditEvents } from "../../db/schema/media.js";

const CLASSES: SelectablePlayerClass[] = ["GARDIST", "MÖNCH", "HÄNDLER", "SPÄHER"];

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

async function playerForAccount(executor: any, accountId: string) {
  const [player] = await executor.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!player) throw httpError(404, "Kein Spielerprofil für dieses Konto gefunden.");
  return player as typeof players.$inferSelect;
}

async function stateFor(executor: any, player: typeof players.$inferSelect) {
  const occupied = await executor
    .select({ playerId: players.id, playerClass: players.class })
    .from(players)
    .where(and(eq(players.teamId, player.teamId), eq(players.classConfirmed, true)));
  return {
    playerId: player.id,
    teamId: player.teamId,
    selectedClass: CLASSES.includes(player.class as SelectablePlayerClass)
      ? (player.class as SelectablePlayerClass)
      : null,
    confirmed: player.classConfirmed,
    confirmedAt: player.classConfirmedAt?.toISOString() ?? null,
    preflightCompleted: player.preflightCompletedAt !== null,
    mapAccessGranted: player.classConfirmed && player.preflightCompletedAt !== null,
    availability: CLASSES.map((playerClass) => {
      const holder = occupied.find((entry: { playerClass: string | null }) => entry.playerClass === playerClass);
      return {
        class: playerClass,
        available: !holder || holder.playerId === player.id,
        occupiedByPlayerId: holder?.playerId ?? null,
      };
    }),
  };
}

export async function getClassSelectionState(accountId: string) {
  const player = await playerForAccount(db, accountId);
  return stateFor(db, player);
}

export async function selectClass(accountId: string, playerClass: SelectablePlayerClass) {
  return db.transaction(async (tx) => {
    const player = await playerForAccount(tx, accountId);
    if (player.classConfirmed) throw httpError(409, "Die bestätigte Klasse ist dauerhaft gebunden.");
    await tx.update(players).set({ class: playerClass, classSelectedAt: new Date() }).where(eq(players.id, player.id));
    return stateFor(tx, { ...player, class: playerClass, classSelectedAt: new Date() });
  });
}

export async function confirmClass(accountId: string, playerClass: SelectablePlayerClass) {
  try {
    return await db.transaction(async (tx) => {
      const player = await playerForAccount(tx, accountId);
      if (player.classConfirmed) {
        if (player.class === playerClass) return stateFor(tx, player);
        throw httpError(409, "Die bestätigte Klasse ist dauerhaft gebunden.");
      }
      // Lock the team row so concurrent confirmations for this team serialize.
      await tx.execute(sql`SELECT id FROM ${teams} WHERE id = ${player.teamId} FOR UPDATE`);
      const [conflict] = await tx.select({ id: players.id }).from(players).where(and(
        eq(players.teamId, player.teamId), eq(players.class, playerClass),
        eq(players.classConfirmed, true), ne(players.id, player.id),
      )).limit(1);
      if (conflict) throw httpError(409, "Diese Klasse ist in deinem Team bereits vergeben.");
      const now = new Date();
      await tx.update(players).set({
        class: playerClass, classConfirmed: true, classSelectedAt: player.classSelectedAt ?? now,
        classConfirmedAt: now, classAssignedBy: accountId, preflightCompletedAt: null,
      }).where(eq(players.id, player.id));
      return stateFor(tx, { ...player, class: playerClass, classConfirmed: true, classConfirmedAt: now, classAssignedBy: accountId, preflightCompletedAt: null });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw httpError(409, "Diese Klasse ist in deinem Team bereits vergeben.");
    throw error;
  }
}

export async function completePreflight(accountId: string) {
  return db.transaction(async (tx) => {
    const player = await playerForAccount(tx, accountId);
    if (!player.classConfirmed) throw httpError(409, "Bestätige zuerst deine Klasse.");
    const now = new Date();
    await tx.update(players).set({ preflightCompletedAt: now }).where(eq(players.id, player.id));
    return stateFor(tx, { ...player, preflightCompletedAt: now });
  });
}

export async function overrideClass(actorId: string, playerId: string, playerClass: SelectablePlayerClass, reason: string) {
  try {
    return await db.transaction(async (tx) => {
      const [player] = await tx.select().from(players).where(eq(players.id, playerId)).limit(1);
      if (!player) throw httpError(404, "Spieler nicht gefunden.");
      await tx.execute(sql`SELECT id FROM ${teams} WHERE id = ${player.teamId} FOR UPDATE`);
      const [conflict] = await tx.select({ id: players.id }).from(players).where(and(
        eq(players.teamId, player.teamId), eq(players.class, playerClass), eq(players.classConfirmed, true), ne(players.id, player.id),
      )).limit(1);
      if (conflict) throw httpError(409, "Diese Klasse ist in diesem Team bereits vergeben.");
      const previousClass = player.class;
      const now = new Date();
      await tx.update(players).set({ class: playerClass, classConfirmed: true, classSelectedAt: now, classConfirmedAt: now, classAssignedBy: actorId, preflightCompletedAt: null }).where(eq(players.id, player.id));
      await tx.insert(auditEvents).values({
        actorId, action: "CLASS_ASSIGNMENT_OVERRIDE", targetRefs: player.id,
        payload: { playerId, teamId: player.teamId, previousClass, newClass: playerClass, reason },
      });
      return { success: true, playerId, previousClass, class: playerClass };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw httpError(409, "Diese Klasse ist in diesem Team bereits vergeben.");
    throw error;
  }
}
