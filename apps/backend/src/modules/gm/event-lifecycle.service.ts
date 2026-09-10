/**
 * Event Lifecycle Service – Epic 9
 * Handles global event state: START/PAUSE/END, leaderboard, and summaries.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../../db/client.js";
import { eventState, auditEvents } from "../../db/schema/media.js";
import { players, teams } from "../../db/schema/player.js";
import { combatInstances } from "../../db/schema/combat.js";
import { ledgerEntries } from "../../db/schema/economy_v2.js";
import { questRuns } from "../../db/schema/quest.js";
import { eq, and, desc, sql } from "drizzle-orm";

export type EventLifecycleState =
  | "NOT_STARTED"
  | "ACTIVE"
  | "PAUSED"
  | "ENDED";

export interface EventState {
  id: string;
  state: EventLifecycleState;
  startedAt: string | null;
  pausedAt: string | null;
  endedAt: string | null;
  leaderboardFrozen: boolean;
  metadata: unknown;
  updatedAt: string;
}

export interface TeamLeaderboardEntry {
  teamId: string;
  teamName: string;
  totalFame: number;
  totalDenarii: number;
  questsCompleted: number;
  rank: number;
}

export interface EventSummary {
  totalTeams: number;
  activeTeams: number;
  totalQuestsCompleted: number;
  totalFameAwarded: number;
  totalDenariiAwarded: number;
  eventDurationMinutes: number;
  topTeam: TeamLeaderboardEntry | null;
}

export class EventLifecycleService {
  private logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger.child({ module: "EventLifecycleService" });
  }

  /**
   * Idempotent day-2 rollover. Permanent progression lives on the existing
   * player/team rows, so class, inventory/equipment, currencies, fame and fame
   * tier bonuses carry over automatically. Only transient combat state is reset.
   */
  async startDay2(actorId: string): Promise<{ day: 2; playersRestored: number }> {
    return db.transaction(async (tx) => {
      const locked = await tx.execute(sql`SELECT id, metadata FROM event_state LIMIT 1 FOR UPDATE`);
      const row = locked.rows[0] as { id: string; metadata: Record<string, unknown> | null } | undefined;
      if (!row) throw new Error("Event state not initialized");
      const metadata = row.metadata ?? {};
      if (Number(metadata["currentDay"] ?? 1) >= 2) return { day: 2 as const, playersRestored: 0 };

      // Ending every regular combat discards round-bound defend/skill effects.
      await tx.update(combatInstances).set({ state: "COMPLETED" })
        .where(sql`${combatInstances.state} <> 'COMPLETED' AND ${combatInstances.type} <> 'BOSS'`);
      const restored = await tx.update(players).set({
        hpCurrent: sql`${players.maxHp}`,
        status: "ACTIVE",
        lastRegenCalculationAt: new Date(),
      }).returning({ id: players.id });
      await tx.update(eventState).set({ metadata: { ...metadata, currentDay: 2 }, updatedAt: new Date() })
        .where(eq(eventState.id, row.id));
      await tx.insert(auditEvents).values({
        actorId, action: "EVENT_CONTROL", targetRefs: null,
        payload: { action: "START_DAY_2", playersRestored: restored.length },
      });
      return { day: 2 as const, playersRestored: restored.length };
    });
  }

  /**
   * Get current event state.
   */
  async getState(): Promise<EventState> {
    const [state] = await db.select().from(eventState).limit(1);

    if (!state) {
      throw new Error("Event state not initialized");
    }

    return {
      id: state.id,
      state: state.state,
      startedAt: state.startedAt?.toISOString() ?? null,
      pausedAt: state.pausedAt?.toISOString() ?? null,
      endedAt: state.endedAt?.toISOString() ?? null,
      leaderboardFrozen: state.leaderboardFrozen,
      metadata: state.metadata,
      updatedAt: state.updatedAt.toISOString(),
    };
  }

  /**
   * START Event: Transition from NOT_STARTED to ACTIVE.
   */
  async startEvent(actorId: string): Promise<EventState> {
    const current = await this.getState();

    if (current.state !== "NOT_STARTED") {
      throw new Error(
        `Cannot start event from state ${current.state}. Expected NOT_STARTED.`,
      );
    }

    const now = new Date();

    const [updated] = await db
      .update(eventState)
      .set({
        state: "ACTIVE",
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(eventState.id, current.id))
      .returning();

    // Log to audit
    await db.insert(auditEvents).values({
      actorId,
      action: "EVENT_CONTROL",
      targetRefs: null,
      payload: { action: "START", timestamp: now.toISOString() },
    });

    this.logger.info({ actorId }, "Event STARTED");

    return {
      ...updated!,
      startedAt: updated!.startedAt!.toISOString(),
      pausedAt: updated!.pausedAt?.toISOString() ?? null,
      endedAt: updated!.endedAt?.toISOString() ?? null,
      updatedAt: updated!.updatedAt.toISOString(),
    };
  }

  /**
   * PAUSE Event: Transition from ACTIVE to PAUSED.
   */
  async pauseEvent(actorId: string): Promise<EventState> {
    const current = await this.getState();

    if (current.state !== "ACTIVE") {
      throw new Error(
        `Cannot pause event from state ${current.state}. Expected ACTIVE.`,
      );
    }

    const now = new Date();

    const [updated] = await db
      .update(eventState)
      .set({
        state: "PAUSED",
        pausedAt: now,
        updatedAt: now,
      })
      .where(eq(eventState.id, current.id))
      .returning();

    // Log to audit
    await db.insert(auditEvents).values({
      actorId,
      action: "EVENT_CONTROL",
      targetRefs: null,
      payload: { action: "PAUSE", timestamp: now.toISOString() },
    });

    this.logger.info({ actorId }, "Event PAUSED");

    return {
      ...updated!,
      startedAt: updated!.startedAt!.toISOString(),
      pausedAt: updated!.pausedAt!.toISOString(),
      endedAt: updated!.endedAt?.toISOString() ?? null,
      updatedAt: updated!.updatedAt.toISOString(),
    };
  }

  /**
   * RESUME Event: Transition from PAUSED back to ACTIVE.
   */
  async resumeEvent(actorId: string): Promise<EventState> {
    const current = await this.getState();

    if (current.state !== "PAUSED") {
      throw new Error(
        `Cannot resume event from state ${current.state}. Expected PAUSED.`,
      );
    }

    const now = new Date();

    const [updated] = await db
      .update(eventState)
      .set({
        state: "ACTIVE",
        updatedAt: now,
      })
      .where(eq(eventState.id, current.id))
      .returning();

    // Log to audit
    await db.insert(auditEvents).values({
      actorId,
      action: "EVENT_CONTROL",
      targetRefs: null,
      payload: { action: "RESUME", timestamp: now.toISOString() },
    });

    this.logger.info({ actorId }, "Event RESUMED");

    return {
      ...updated!,
      startedAt: updated!.startedAt!.toISOString(),
      pausedAt: updated!.pausedAt?.toISOString() ?? null,
      endedAt: updated!.endedAt?.toISOString() ?? null,
      updatedAt: updated!.updatedAt.toISOString(),
    };
  }

  /**
   * END Event: Transition from ACTIVE/PAUSED to ENDED and freeze leaderboard.
   */
  async endEvent(actorId: string): Promise<EventState> {
    const current = await this.getState();

    if (current.state === "ENDED") {
      throw new Error("Event already ended");
    }

    if (current.state === "NOT_STARTED") {
      throw new Error("Cannot end event that has not started");
    }

    const now = new Date();

    const [updated] = await db
      .update(eventState)
      .set({
        state: "ENDED",
        endedAt: now,
        leaderboardFrozen: true,
        updatedAt: now,
      })
      .where(eq(eventState.id, current.id))
      .returning();

    // Log to audit
    await db.insert(auditEvents).values({
      actorId,
      action: "EVENT_CONTROL",
      targetRefs: null,
      payload: { action: "END", timestamp: now.toISOString() },
    });

    this.logger.info({ actorId }, "Event ENDED and leaderboard FROZEN");

    return {
      ...updated!,
      startedAt: updated!.startedAt!.toISOString(),
      pausedAt: updated!.pausedAt?.toISOString() ?? null,
      endedAt: updated!.endedAt!.toISOString(),
      updatedAt: updated!.updatedAt.toISOString(),
    };
  }

  /**
   * Get live leaderboard (or frozen if event ended).
   * Ranks teams by FAME, then DENARII.
   */
  async getLeaderboard(): Promise<TeamLeaderboardEntry[]> {
    // Aggregate FAME and DENARII per team
    const fameResults = await db
      .select({
        teamId: ledgerEntries.teamId,
        totalFame: sql<number>`COALESCE(SUM(${ledgerEntries.amount}), 0)`,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.currencyType, "FAME"))
      .groupBy(ledgerEntries.teamId);

    const denariiResults = await db
      .select({
        teamId: ledgerEntries.teamId,
        totalDenarii: sql<number>`COALESCE(SUM(${ledgerEntries.amount}), 0)`,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.currencyType, "DENARII"))
      .groupBy(ledgerEntries.teamId);

    const questsCompletedResults = await db
      .select({
        teamId: questRuns.teamId,
        count: sql<number>`COUNT(*)`,
      })
      .from(questRuns)
      .where(eq(questRuns.state, "COMPLETED"))
      .groupBy(questRuns.teamId);

    // Get all teams
    const allTeams = await db.select().from(teams);

    // Build leaderboard
    const leaderboard: TeamLeaderboardEntry[] = allTeams.map((team) => {
      const fame =
        fameResults.find((r) => r.teamId === team.id)?.totalFame ?? 0;
      const denarii =
        denariiResults.find((r) => r.teamId === team.id)?.totalDenarii ?? 0;
      const quests =
        questsCompletedResults.find((r) => r.teamId === team.id)?.count ?? 0;

      return {
        teamId: team.id,
        teamName: team.name,
        totalFame: Number(fame),
        totalDenarii: Number(denarii),
        questsCompleted: Number(quests),
        rank: 0, // Will be assigned below
      };
    });

    // Sort by FAME desc, then DENARII desc
    leaderboard.sort((a, b) => {
      if (b.totalFame !== a.totalFame) return b.totalFame - a.totalFame;
      return b.totalDenarii - a.totalDenarii;
    });

    // Assign ranks
    leaderboard.forEach((entry, index) => {
      entry.rank = index + 1;
    });

    return leaderboard;
  }

  /**
   * Get event summary/statistics.
   */
  async getSummary(): Promise<EventSummary> {
    const state = await this.getState();
    const leaderboard = await this.getLeaderboard();

    const allTeams = await db.select().from(teams);
    const activeTeams = allTeams.filter((t) => t.isActive === 1).length;

    const totalQuestsCompleted = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(questRuns)
      .where(eq(questRuns.state, "COMPLETED"));

    const totalFame = await db
      .select({
        total: sql<number>`COALESCE(SUM(${ledgerEntries.amount}), 0)`,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.currencyType, "FAME"));

    const totalDenarii = await db
      .select({
        total: sql<number>`COALESCE(SUM(${ledgerEntries.amount}), 0)`,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.currencyType, "DENARII"));

    // Calculate event duration
    let durationMinutes = 0;
    if (state.startedAt) {
      const start = new Date(state.startedAt);
      const end = state.endedAt ? new Date(state.endedAt) : new Date();
      durationMinutes = Math.floor((end.getTime() - start.getTime()) / 60000);
    }

    return {
      totalTeams: allTeams.length,
      activeTeams,
      totalQuestsCompleted: Number(totalQuestsCompleted[0]?.count ?? 0),
      totalFameAwarded: Number(totalFame[0]?.total ?? 0),
      totalDenariiAwarded: Number(totalDenarii[0]?.total ?? 0),
      eventDurationMinutes: durationMinutes,
      topTeam: leaderboard[0] ?? null,
    };
  }

  /**
   * Freeze or unfreeze leaderboard (independent of event state).
   */
  async toggleLeaderboardFreeze(
    actorId: string,
    freeze: boolean,
  ): Promise<EventState> {
    const current = await this.getState();

    const [updated] = await db
      .update(eventState)
      .set({
        leaderboardFrozen: freeze,
        updatedAt: new Date(),
      })
      .where(eq(eventState.id, current.id))
      .returning();

    await db.insert(auditEvents).values({
      actorId,
      action: "EVENT_CONTROL",
      targetRefs: null,
      payload: { action: freeze ? "FREEZE_LEADERBOARD" : "UNFREEZE_LEADERBOARD" },
    });

    this.logger.info({ actorId, freeze }, "Leaderboard freeze toggled");

    return {
      ...updated!,
      startedAt: updated!.startedAt?.toISOString() ?? null,
      pausedAt: updated!.pausedAt?.toISOString() ?? null,
      endedAt: updated!.endedAt?.toISOString() ?? null,
      updatedAt: updated!.updatedAt.toISOString(),
    };
  }
}
