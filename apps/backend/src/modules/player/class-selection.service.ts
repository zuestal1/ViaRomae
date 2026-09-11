import { and, eq, sql } from "drizzle-orm";
import type { SelectablePlayerClass } from "@jlw/contracts";
import { db } from "../../db/client.js";
import { players, teams } from "../../db/schema/player.js";
import { auditEvents } from "../../db/schema/media.js";
import { itemInstances } from "../../db/schema/economy_v2.js";
import { STARTER_WEAPONS } from "../classes/class-rules.js";

const CLASSES: SelectablePlayerClass[] = ["guard", "cleric", "sculptor", "condottiere"];

export type ClassSelectionPlayer = {
  id: string;
  accountId: string;
  teamId: string;
  class: SelectablePlayerClass | null;
  classConfirmed: boolean;
  classSelectedAt: Date | null;
  classConfirmedAt: Date | null;
  classAssignedBy: string | null;
  preflightCompletedAt: Date | null;
};

export type ClassSelectionUpdate = Partial<Pick<ClassSelectionPlayer,
  "class" | "classConfirmed" | "classSelectedAt" | "classConfirmedAt" | "classAssignedBy" | "preflightCompletedAt">>;

/** Persistence boundary for the one authoritative class-selection domain service. */
export interface ClassSelectionRepository {
  transaction<T>(work: (repository: ClassSelectionRepository) => Promise<T>): Promise<T>;
  findByAccount(accountId: string): Promise<ClassSelectionPlayer | undefined>;
  findById(playerId: string): Promise<ClassSelectionPlayer | undefined>;
  confirmedPlayers(teamId: string): Promise<Array<Pick<ClassSelectionPlayer, "id" | "class">>>;
  lockTeam(teamId: string): Promise<void>;
  updatePlayer(playerId: string, update: ClassSelectionUpdate): Promise<void>;
  grantStarterWeapon(playerId: string, definitionId: string): Promise<void>;
  appendOverrideAudit(input: { actorId: string; playerId: string; teamId: string; previousClass: SelectablePlayerClass | null; newClass: SelectablePlayerClass; reason: string }): Promise<void>;
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

const asPlayer = (player: typeof players.$inferSelect): ClassSelectionPlayer => ({
  id: player.id, accountId: player.accountId, teamId: player.teamId,
  class: player.class as SelectablePlayerClass | null,
  classConfirmed: player.classConfirmed, classSelectedAt: player.classSelectedAt,
  classConfirmedAt: player.classConfirmedAt, classAssignedBy: player.classAssignedBy,
  preflightCompletedAt: player.preflightCompletedAt,
});

class DrizzleClassSelectionRepository implements ClassSelectionRepository {
  constructor(private readonly executor: any) {}
  transaction<T>(work: (repository: ClassSelectionRepository) => Promise<T>): Promise<T> {
    return this.executor.transaction((tx: any) => work(new DrizzleClassSelectionRepository(tx)));
  }
  async findByAccount(accountId: string) {
    const [player] = await this.executor.select().from(players).where(eq(players.accountId, accountId)).limit(1);
    return player ? asPlayer(player) : undefined;
  }
  async findById(playerId: string) {
    const [player] = await this.executor.select().from(players).where(eq(players.id, playerId)).limit(1);
    return player ? asPlayer(player) : undefined;
  }
  async confirmedPlayers(teamId: string) {
    return this.executor.select({ id: players.id, class: players.class }).from(players)
      .where(and(eq(players.teamId, teamId), eq(players.classConfirmed, true)));
  }
  async lockTeam(teamId: string) {
    await this.executor.execute(sql`SELECT id FROM ${teams} WHERE id = ${teamId} FOR UPDATE`);
  }
  async updatePlayer(playerId: string, update: ClassSelectionUpdate) {
    await this.executor.update(players).set(update).where(eq(players.id, playerId));
  }
  async grantStarterWeapon(playerId: string, definitionId: string) {
    const [existing] = await this.executor.select({ id: itemInstances.id }).from(itemInstances)
      .where(and(eq(itemInstances.ownerId, playerId), eq(itemInstances.definitionId, definitionId))).limit(1);
    if (!existing) await this.executor.insert(itemInstances).values({
      definitionId, ownerType: "PLAYER", ownerId: playerId, quantity: 1,
      category: "EQUIPMENT", slot: "WEAPON", isEquipped: true, isBound: true,
    });
  }
  async appendOverrideAudit(input: Parameters<ClassSelectionRepository["appendOverrideAudit"]>[0]) {
    await this.executor.insert(auditEvents).values({
      actorId: input.actorId, action: "CLASS_ASSIGNMENT_OVERRIDE", targetRefs: input.playerId,
      payload: { playerId: input.playerId, teamId: input.teamId, previousClass: input.previousClass, newClass: input.newClass, reason: input.reason },
    });
  }
}

export class ClassSelectionService {
  constructor(private readonly repository: ClassSelectionRepository) {}

  private async playerForAccount(repository: ClassSelectionRepository, accountId: string) {
    const player = await repository.findByAccount(accountId);
    if (!player) throw httpError(404, "Kein Spielerprofil für dieses Konto gefunden.");
    return player;
  }
  private async stateFor(repository: ClassSelectionRepository, player: ClassSelectionPlayer) {
    const occupied = await repository.confirmedPlayers(player.teamId);
    return {
      playerId: player.id, teamId: player.teamId,
      selectedClass: player.class && CLASSES.includes(player.class) ? player.class : null,
      confirmed: player.classConfirmed, confirmedAt: player.classConfirmedAt?.toISOString() ?? null,
      preflightCompleted: player.preflightCompletedAt !== null,
      mapAccessGranted: player.classConfirmed && player.preflightCompletedAt !== null,
      availability: CLASSES.map((playerClass) => {
        const holder = occupied.find((entry) => entry.class === playerClass);
        return { class: playerClass, available: !holder || holder.id === player.id, occupiedByPlayerId: holder?.id ?? null };
      }),
    };
  }
  private async inTransaction<T>(work: (repository: ClassSelectionRepository) => Promise<T>) {
    try { return await this.repository.transaction(work); }
    catch (error) {
      if ((error as { code?: string }).code === "23505") throw httpError(409, "Diese Klasse ist in deinem Team bereits vergeben.");
      throw error;
    }
  }

  async getState(accountId: string) {
    const player = await this.playerForAccount(this.repository, accountId);
    return this.stateFor(this.repository, player);
  }
  async select(accountId: string, playerClass: SelectablePlayerClass) {
    return this.inTransaction(async (repository) => {
      const player = await this.playerForAccount(repository, accountId);
      if (player.classConfirmed) throw httpError(409, "Die bestätigte Klasse ist dauerhaft gebunden.");
      const now = new Date();
      await repository.updatePlayer(player.id, { class: playerClass, classSelectedAt: now });
      return this.stateFor(repository, { ...player, class: playerClass, classSelectedAt: now });
    });
  }
  async confirm(accountId: string, playerClass: SelectablePlayerClass) {
    return this.inTransaction(async (repository) => {
      const player = await this.playerForAccount(repository, accountId);
      if (player.classConfirmed) {
        if (player.class === playerClass) return this.stateFor(repository, player);
        throw httpError(409, "Die bestätigte Klasse ist dauerhaft gebunden.");
      }
      await repository.lockTeam(player.teamId);
      const conflict = (await repository.confirmedPlayers(player.teamId)).some((entry) => entry.class === playerClass && entry.id !== player.id);
      if (conflict) throw httpError(409, "Diese Klasse ist in deinem Team bereits vergeben.");
      const now = new Date();
      const update = { class: playerClass, classConfirmed: true, classSelectedAt: player.classSelectedAt ?? now, classConfirmedAt: now, classAssignedBy: accountId, preflightCompletedAt: null };
      await repository.updatePlayer(player.id, update);
      await repository.grantStarterWeapon(player.id, STARTER_WEAPONS[playerClass].id);
      return this.stateFor(repository, { ...player, ...update });
    });
  }
  async completePreflight(accountId: string) {
    return this.inTransaction(async (repository) => {
      const player = await this.playerForAccount(repository, accountId);
      if (!player.classConfirmed) throw httpError(409, "Bestätige zuerst deine Klasse.");
      const now = new Date();
      await repository.updatePlayer(player.id, { preflightCompletedAt: now });
      return this.stateFor(repository, { ...player, preflightCompletedAt: now });
    });
  }
  async override(actorId: string, playerId: string, playerClass: SelectablePlayerClass, reason: string) {
    if (!reason.trim()) throw httpError(400, "Für die Korrektur ist eine Begründung erforderlich.");
    return this.inTransaction(async (repository) => {
      const player = await repository.findById(playerId);
      if (!player) throw httpError(404, "Spieler nicht gefunden.");
      await repository.lockTeam(player.teamId);
      const conflict = (await repository.confirmedPlayers(player.teamId)).some((entry) => entry.class === playerClass && entry.id !== player.id);
      if (conflict) throw httpError(409, "Diese Klasse ist in diesem Team bereits vergeben.");
      const now = new Date();
      await repository.updatePlayer(player.id, { class: playerClass, classConfirmed: true, classSelectedAt: now, classConfirmedAt: now, classAssignedBy: actorId, preflightCompletedAt: null });
      await repository.grantStarterWeapon(player.id, STARTER_WEAPONS[playerClass].id);
      await repository.appendOverrideAudit({ actorId, playerId, teamId: player.teamId, previousClass: player.class, newClass: playerClass, reason });
      return { success: true, playerId, previousClass: player.class, class: playerClass };
    });
  }
}

export const classSelectionService = new ClassSelectionService(new DrizzleClassSelectionRepository(db));
