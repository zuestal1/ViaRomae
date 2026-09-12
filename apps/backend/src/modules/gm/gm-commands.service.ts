/**
 * GM Commands Service – Epic 9
 * Reversible, audit-logged commands for game master intervention.
 * All actions are logged to the audit_event table.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../../db/client.js";
import { auditEvents, eventState } from "../../db/schema/media.js";
import { questDefinitions, questRuns, questSteps, questStepWaypoints, questWaypointProgress, objectiveProgress } from "../../db/schema/quest.js";
import { mediaSubmissions } from "../../db/schema/media.js";
import { combatInstances } from "../../db/schema/combat.js";
import { teams, players } from "../../db/schema/player.js";
import { ledgerEntries } from "../../db/schema/economy_v2.js";
import { appendLedgerEntry } from "../economy/ledger.service.js";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { WsHub } from "../ws/ws.hub.js";
import { cancelQuestStepTimers, completeQuest, isTerminalObjectiveStatus } from "../quest/quest.service.js";
import type { SkipQuestStepResponse } from "@jlw/contracts";

export type GMCommandType =
  | "QUEST_RESET"
  | "QUEST_STEP_SKIP"
  | "HP_OVERRIDE"
  | "LOCATION_OVERRIDE"
  | "CURRENCY_CORRECTION"
  | "ITEM_GRANT"
  | "EVENT_CONTROL";

export interface AuditLog {
  id: string;
  actorId: string;
  action: string;
  targetRefs: string | null;
  payload: unknown;
  createdAt: string;
}

export class GMCommandService {
  private logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger, private readonly wsHub?: WsHub) {
    this.logger = logger.child({ module: "GMCommandService" });
  }

  async skipCurrentQuestStep(actorId: string, questRunId: string, stepId: string): Promise<SkipQuestStepResponse> {
    let teamId = "";
    let definitionId = "";
    let timerIds: string[] = [];
    const outcome = await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`SELECT * FROM quest_run WHERE id=${questRunId}::uuid FOR UPDATE`);
      const run = locked.rows[0] as { id: string; team_id: string; quest_definition_id: string; state: string; runtime_state: Record<string, unknown> } | undefined;
      if (!run) throw Object.assign(new Error("Quest run not found"), { statusCode: 404 });
      const existing = await tx.select().from(objectiveProgress).where(and(eq(objectiveProgress.questRunId, questRunId), eq(objectiveProgress.objectiveId, stepId))).limit(1);
      if (existing[0]?.status === "SKIPPED") return { alreadySkipped: true, teamId: run.team_id, definitionId: run.quest_definition_id };
      if (run.state !== "ACTIVE") throw Object.assign(new Error("Quest run is not active"), { statusCode: 409 });
      const rows = await tx.select({ step: questSteps, progress: objectiveProgress }).from(questSteps)
        .leftJoin(objectiveProgress, and(eq(objectiveProgress.questRunId, questRunId), eq(objectiveProgress.objectiveId, questSteps.stepId)))
        .where(and(eq(questSteps.questDefinitionId, run.quest_definition_id), eq(questSteps.stepCategory, "OBJECTIVE"), eq(questSteps.required, true)))
        .orderBy(questSteps.sequence);
      const current = rows.find(({ progress }) => !isTerminalObjectiveStatus(progress?.status));
      if (!current || current.step.stepId !== stepId) throw Object.assign(new Error("Step is not the current quest objective"), { statusCode: 409 });
      const previousStatus = current.progress?.status ?? "PENDING";
      await tx.insert(objectiveProgress).values({ questRunId, objectiveId: stepId, status: "SKIPPED", progressCount: current.progress?.progressCount ?? 0 })
        .onConflictDoUpdate({ target: [objectiveProgress.questRunId, objectiveProgress.objectiveId], set: { status: "SKIPPED" } });
      const [definition] = await tx.select().from(questDefinitions).where(eq(questDefinitions.id, run.quest_definition_id));
      const authored = definition?.authoredContent as { timers?: Array<{ id: string; stepId: string }> } | undefined;
      timerIds = authored?.timers?.filter((timer) => timer.stepId === stepId).map((timer) => timer.id) ?? [];
      const runtime = { ...(run.runtime_state ?? {}) } as Record<string, any>;
      if (runtime.timers) for (const id of timerIds) if (runtime.timers[id]) runtime.timers[id] = { ...runtime.timers[id], state: "COMPLETED", resolvedBy: "GM_SKIP" };
      runtime.skippedStepIds = Array.from(new Set([...(runtime.skippedStepIds ?? []), stepId]));
      const combatId = typeof runtime.activeCombatId === "string" ? runtime.activeCombatId : undefined;
      delete runtime.activeCombatId;
      await tx.update(questRuns).set({ runtimeState: runtime }).where(eq(questRuns.id, questRunId));
      if (combatId) await tx.update(combatInstances).set({ state: "COMPLETED", completedAt: new Date(), outcome: "GM_STEP_SKIPPED" }).where(eq(combatInstances.id, combatId));
      await tx.update(mediaSubmissions).set({ status: "REJECTED" }).where(and(eq(mediaSubmissions.questRunId, questRunId), eq(mediaSubmissions.stepId, stepId)));
      const waypointIds = await tx.select({ id: questStepWaypoints.id }).from(questStepWaypoints).where(eq(questStepWaypoints.questStepId, current.step.id));
      if (waypointIds.length) await tx.delete(questWaypointProgress).where(and(eq(questWaypointProgress.questRunId, questRunId), inArray(questWaypointProgress.waypointId, waypointIds.map((row) => row.id))));
      await tx.insert(auditEvents).values({ actorId, action: "QUEST_STEP_SKIP", targetRefs: questRunId,
        payload: { questRunId, teamId: run.team_id, stepId, previousStatus } });
      return { alreadySkipped: false, teamId: run.team_id, definitionId: run.quest_definition_id };
    });
    teamId = outcome.teamId; definitionId = outcome.definitionId;
    cancelQuestStepTimers(questRunId, timerIds);
    const remaining = await db.select({ step: questSteps, progress: objectiveProgress }).from(questSteps)
      .leftJoin(objectiveProgress, and(eq(objectiveProgress.questRunId, questRunId), eq(objectiveProgress.objectiveId, questSteps.stepId)))
      .where(and(eq(questSteps.questDefinitionId, definitionId), eq(questSteps.stepCategory, "OBJECTIVE"), eq(questSteps.required, true))).orderBy(questSteps.sequence);
    const next = remaining.find(({ progress }) => !isTerminalObjectiveStatus(progress?.status));
    let questCompleted = !next;
    if (questCompleted) {
      const [player] = await db.select({ accountId: players.accountId }).from(players).where(eq(players.teamId, teamId)).limit(1);
      if (!player) throw Object.assign(new Error("Quest team has no player for reward ownership"), { statusCode: 409 });
      await completeQuest({ accountId: player.accountId, questRunId, ...(this.wsHub ? { wsHub: this.wsHub } : {}) });
    }
    const nextStep = next ? { stepId: next.step.stepId, sequence: next.step.sequence,
      description: ((next.step.authoredContent as { description?: string; text?: string }).description ?? (next.step.authoredContent as { text?: string }).text ?? next.step.targetRef) } : null;
    this.wsHub?.sendToTeam(teamId, { event: "quest.step_skipped", teamId, questRunId, skippedStepId: stepId, nextStep, source: "GM", timestamp: new Date().toISOString() });
    return { success: true, questRunId, skippedStepId: stepId, nextStep, questCompleted };
  }

  /**
   * Log a GM command to audit_event table.
   */
  private async logAudit(
    actorId: string,
    action: GMCommandType,
    targetRefs: string | null,
    payload: unknown,
  ): Promise<void> {
    await db.insert(auditEvents).values({
      actorId,
      action,
      targetRefs,
      payload: payload as any,
    });

    this.logger.info({ actorId, action, targetRefs }, "GM command executed");
  }

  /**
   * QUEST_RESET: Reset a quest run to ACTIVE state and clear progress.
   * Reversible by re-accepting the quest.
   */
  async resetQuest(
    actorId: string,
    questRunId: string,
  ): Promise<{ success: boolean; message: string }> {
    const [questRun] = await db
      .select()
      .from(questRuns)
      .where(eq(questRuns.id, questRunId))
      .limit(1);

    if (!questRun) {
      throw new Error("Quest run not found");
    }

    // Store previous state for audit
    const previousState = questRun.state;

    // Reset quest run to ACTIVE
    await db
      .update(questRuns)
      .set({
        state: "ACTIVE",
        completedAt: null,
        acceptedAt: new Date(),
      })
      .where(eq(questRuns.id, questRunId));

    // Clear objective progress
    await db
      .delete(objectiveProgress)
      .where(eq(objectiveProgress.questRunId, questRunId));

    await this.logAudit(actorId, "QUEST_RESET", questRunId, {
      questRunId,
      previousState,
      teamId: questRun.teamId,
    });

    return {
      success: true,
      message: `Quest ${questRunId} reset from ${previousState} to ACTIVE`,
    };
  }

  /**
   * HP_OVERRIDE: Directly set a team's HP value.
   * Use for emergency corrections or event balancing.
   */
  async overrideHP(
    actorId: string,
    teamId: string,
    newHP: number,
  ): Promise<{ success: boolean; message: string; previousHP: number }> {
    const [team] = await db
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    if (!team) {
      throw new Error("Team not found");
    }

    const previousHP = team.hp;

    await db.update(teams).set({ hp: newHP }).where(eq(teams.id, teamId));

    await this.logAudit(actorId, "HP_OVERRIDE", teamId, {
      teamId,
      previousHP,
      newHP,
    });

    return {
      success: true,
      message: `Team ${team.name} HP changed from ${previousHP} to ${newHP}`,
      previousHP,
    };
  }

  /**
   * LOCATION_OVERRIDE: Manually set a player's location.
   * Use for stuck players or location bugs.
   */
  async overrideLocation(
    actorId: string,
    playerId: string,
    lat: number,
    lng: number,
  ): Promise<{ success: boolean; message: string }> {
    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);

    if (!player) {
      throw new Error("Player not found");
    }

    const previousLocation = {
      lat: player.lastLat,
      lng: player.lastLng,
    };

    await db
      .update(players)
      .set({
        lastLat: lat,
        lastLng: lng,
        lastLocationUpdate: new Date(),
      })
      .where(eq(players.id, playerId));

    await this.logAudit(actorId, "LOCATION_OVERRIDE", playerId, {
      playerId,
      previousLocation,
      newLocation: { lat, lng },
    });

    return {
      success: true,
      message: `Player ${player.playerName} location overridden`,
    };
  }

  /**
   * CURRENCY_CORRECTION: Add or subtract currency (FAME/DENARII).
   * Creates a ledger entry with source=ADMIN.
   * Supports negative amounts for corrections.
   */
  async correctCurrency(
    actorId: string,
    teamId: string,
    currencyType: "FAME" | "DENARII",
    amount: number,
    reason: string,
  ): Promise<{ success: boolean; message: string }> {
    const [team] = await db
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    if (!team) {
      throw new Error("Team not found");
    }

    const idempotencyKey = randomUUID();

    await appendLedgerEntry({
      idempotencyKey,
      teamId,
      currencyType,
      amount,
      source: "ADMIN",
    });

    await this.logAudit(actorId, "CURRENCY_CORRECTION", teamId, {
      teamId,
      currencyType,
      amount,
      reason,
      idempotencyKey,
    });

    return {
      success: true,
      message: `${amount > 0 ? "Added" : "Removed"} ${Math.abs(amount)} ${currencyType} ${amount > 0 ? "to" : "from"} team ${team.name}`,
    };
  }

  /**
   * Get audit log with pagination and filtering.
   */
  async getAuditLog(opts: {
    limit?: number;
    offset?: number;
    actorId?: string;
    action?: GMCommandType;
  }): Promise<AuditLog[]> {
    const { limit = 50, offset = 0, actorId: filterActorId, action } = opts;

    let query = db.select().from(auditEvents);

    if (filterActorId) {
      query = query.where(eq(auditEvents.actorId, filterActorId)) as any;
    }

    if (action) {
      const condition = eq(auditEvents.action, action);
      query = filterActorId
        ? (query.where(
            and(eq(auditEvents.actorId, filterActorId), condition),
          ) as any)
        : (query.where(condition) as any);
    }

    const results = await query
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit)
      .offset(offset);

    return results.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      action: r.action,
      targetRefs: r.targetRefs,
      payload: r.payload,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Get event state.
   */
  async getEventState() {
    const [state] = await db.select().from(eventState).limit(1);
    
    if (!state) {
      throw new Error("Event state not found");
    }

    return {
      ...state,
      startedAt: state.startedAt?.toISOString() ?? null,
      pausedAt: state.pausedAt?.toISOString() ?? null,
      endedAt: state.endedAt?.toISOString() ?? null,
      updatedAt: state.updatedAt.toISOString(),
    };
  }
}
