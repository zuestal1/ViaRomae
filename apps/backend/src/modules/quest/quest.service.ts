/**
 * Quest Service – Epic 4 Flow-Phase State Machine
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Drives the full DISCOVER → DIALOGUE → ACCEPT → OBJECTIVE → COMPLETE lifecycle.
 *
 * Public API:
 *   getActiveRuns(teamId)              → QuestRunDetail[] for active runs
 *   getAvailableQuests(teamId)         → Quests in proximity, not yet accepted
 *   acceptQuest(opts)                  → Create QuestRun; enforce slot ≤ 3
 *   validateReachLocation(opts)        → PostGIS distance check for REACH_LOCATION
 *   submitAnswer(opts)                 → Answer check for ANSWER_QUESTION/SOLVE_PUZZLE
 *   completeQuest(opts)                → Finalize run after all objectives done
 *
 * Flow-phase logic (pre-accept):
 *   Proximity zone DISCOVERED  → discoveryPhase = "DISCOVER"
 *   Proximity zone INTERACTING → discoveryPhase = "DIALOGUE"
 *
 * WorldObject externalId convention:
 *   The GeoJSON seeds WorldObjects with Feature.id as externalId, e.g.
 *   "location:place_day_1_acquedotto_vergine".
 *   QuestStep.targetRef stores only the candidate_id part:
 *   "place_day_1_acquedotto_vergine".
 *   lookupWorldObjectByTargetRef() handles the "location:" prefix resolution.
 *
 * Team-sync requirement (ANSWER_QUESTION / SOLVE_PUZZLE):
 *   All team members must be connected via WebSocket when submitting an answer.
 *   Pass opts.requireAllMembersOnline = true from the route handler to enforce.
 */

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  objectiveProgress,
  questDefinitions,
  questClassUnlocks,
  questDialogueDecisions,
  questRuns,
  questStations,
  questSteps,
} from "../../db/schema/quest.js";
import { players } from "../../db/schema/player.js";
import { worldObjects } from "../../db/schema/world.js";
import { playerProximityStates } from "../../db/schema/proximity.js";
import { checkEffectiveDistance } from "../geo/geo.service.js";
import type { WsHub } from "../ws/ws.hub.js";
import type {
  QuestAcceptedEvent,
  QuestAvailable,
  QuestCompletedEvent,
  QuestRunDetail,
  QuestStep,
  QuestStepCompletedEvent,
  StepResult,
  ClassUnlockDefinition,
  ClassUnlockView,
} from "@jlw/contracts";
import { ClassUnlockDefinitionSchema } from "@jlw/contracts";
import {
  grantRewards,
  QUEST_REWARD_PROFILE,
  COMBAT_REWARD_PROFILE,
} from "../economy/rewards.service.js";
import { decideQuestAcceptance } from "./quest-repeatability.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ACTIVE_QUESTS = 3;
const CLASS_PRESENCE_MAX_AGE_MS = 2 * 60 * 1000;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Validate and persist class content. This is deliberately separate from main
 * quest steps: a class condition can therefore never become a completion guard.
 */
export async function createClassUnlockDefinition(
  input: ClassUnlockDefinition,
): Promise<typeof questClassUnlocks.$inferSelect> {
  const definition = ClassUnlockDefinitionSchema.parse(input);
  const [quest] = await db.select().from(questDefinitions)
    .where(eq(questDefinitions.id, definition.questDefinitionId));
  if (!quest) throw httpError("Quest definition not found.", 404);

  let effect: Record<string, unknown>;
  try { effect = JSON.parse(definition.effectJson) as Record<string, unknown>; }
  catch { throw httpError("effectJson must be valid JSON.", 400); }

  // Triggered quests are the only quests whose availability may depend on a class.
  if (["SIDE_QUEST", "HIDDEN_QUEST_TRIGGER"].includes(definition.kind)) {
    const targetId = effect.targetQuestDefinitionId;
    if (typeof targetId !== "string") {
      throw httpError("Quest unlocks require effectJson.targetQuestDefinitionId.", 400);
    }
    const [target] = await db.select().from(questDefinitions)
      .where(eq(questDefinitions.id, targetId));
    if (!target) throw httpError("Target quest definition not found.", 400);
    if (target.type === "REGULAR") {
      throw httpError("A class condition cannot gate a regular main quest.", 400);
    }
    if (definition.kind === "HIDDEN_QUEST_TRIGGER" && target.type !== "HIDDEN") {
      throw httpError("A hidden-quest trigger must target a HIDDEN quest.", 400);
    }
  }

  // Include bonuses already declared by the quest's content data in the cap.
  let content: Record<string, unknown> = {};
  try { content = JSON.parse(quest.contentJson) as Record<string, unknown>; } catch { /* validated below as zero */ }
  const existingGlory = Number(content.bonus_glory_percent ?? content.bonusGloryPercent ?? 0);
  const existingDenarii = Number(content.bonus_denarii_percent ?? content.bonusDenariiPercent ?? 0);
  const existingClassUnlocks = await db.select({
    glory: questClassUnlocks.bonusGloryPercent,
    denarii: questClassUnlocks.bonusDenariiPercent,
  }).from(questClassUnlocks).where(eq(questClassUnlocks.questDefinitionId, quest.id));
  const accumulatedClassGlory = existingClassUnlocks.reduce((sum, row) => sum + row.glory, 0);
  const accumulatedClassDenarii = existingClassUnlocks.reduce((sum, row) => sum + row.denarii, 0);
  if (quest.type === "REGULAR" &&
      (existingGlory + accumulatedClassGlory + definition.bonusGloryPercent > 15 ||
       existingDenarii + accumulatedClassDenarii + definition.bonusDenariiPercent > 15)) {
    throw httpError("Class bonuses plus all other regular-quest bonuses may not exceed 15%.", 400);
  }

  const [created] = await db.insert(questClassUnlocks).values({
    questDefinitionId: definition.questDefinitionId,
    worldObjectId: definition.condition.worldObjectId,
    nodeId: definition.nodeId,
    optionId: definition.optionId,
    kind: definition.kind,
    requiredClass: definition.condition.requiredClass,
    subject: definition.subject ?? null,
    text: definition.text,
    effectJson: definition.effectJson,
    required: false,
    bonusGloryPercent: definition.bonusGloryPercent,
    bonusDenariiPercent: definition.bonusDenariiPercent,
  }).returning();
  if (!created) throw new Error("Failed to create class unlock.");
  return created;
}

/** Only current server proximity counts; team membership or stale GPS does not. */
export async function hasPresentLivingClassMember(opts: {
  teamId: string; requiredClass: string; worldObjectId: string;
}): Promise<boolean> {
  const rows = await db.select({ id: players.id }).from(players)
    .innerJoin(playerProximityStates, eq(playerProximityStates.playerId, players.id))
    .where(and(
      eq(players.teamId, opts.teamId),
      eq(players.class, opts.requiredClass as typeof players.class.enumValues[number]),
      eq(players.status, "ACTIVE"),
      sql`${players.hpCurrent} > 0`,
      eq(playerProximityStates.worldObjectId, opts.worldObjectId),
      inArray(playerProximityStates.zone, ["INTERACTING", "AGGRO", "BOSS_JOIN"]),
      sql`${playerProximityStates.updatedAt} >= ${new Date(Date.now() - CLASS_PRESENCE_MAX_AGE_MS)}`,
    )).limit(1);
  return rows.length > 0;
}

/** Return only class options which are actually usable at this location now. */
export async function getAvailableClassUnlocks(opts: {
  teamId: string; questDefinitionId: string; nodeId: string;
}): Promise<ClassUnlockView[]> {
  const [decision] = await db.select().from(questDialogueDecisions)
    .innerJoin(questRuns, eq(questDialogueDecisions.questRunId, questRuns.id))
    .where(and(eq(questRuns.teamId, opts.teamId), eq(questRuns.questDefinitionId, opts.questDefinitionId),
      eq(questDialogueDecisions.nodeId, opts.nodeId))).limit(1);
  if (decision) return [];
  const definitions = await db.select().from(questClassUnlocks).where(and(
    eq(questClassUnlocks.questDefinitionId, opts.questDefinitionId),
    eq(questClassUnlocks.nodeId, opts.nodeId), eq(questClassUnlocks.required, false),
  ));
  const visible: ClassUnlockView[] = [];
  for (const item of definitions) {
    if (await hasPresentLivingClassMember({ teamId: opts.teamId, requiredClass: item.requiredClass, worldObjectId: item.worldObjectId })) {
      visible.push({
        id: item.id, questDefinitionId: item.questDefinitionId, nodeId: item.nodeId,
        optionId: item.optionId, kind: item.kind, text: item.text,
        condition: { requiredClass: item.requiredClass, worldObjectId: item.worldObjectId },
        subject: item.subject, required: false, bonusGloryPercent: item.bonusGloryPercent,
        bonusDenariiPercent: item.bonusDenariiPercent, effectJson: item.effectJson,
      });
    }
  }
  return visible;
}

/** Atomically records the team's binding choice; an existing node choice wins. */
export async function chooseClassUnlock(opts: {
  accountId: string; questRunId: string; nodeId: string; optionId: string;
}): Promise<typeof questDialogueDecisions.$inferSelect> {
  const player = await resolvePlayer(opts.accountId);
  const [run] = await db.select().from(questRuns).where(and(
    eq(questRuns.id, opts.questRunId), eq(questRuns.teamId, player.teamId), eq(questRuns.state, "ACTIVE"),
  ));
  if (!run) throw httpError("QuestRun not found or not active.", 404);
  const [unlock] = await db.select().from(questClassUnlocks).where(and(
    eq(questClassUnlocks.questDefinitionId, run.questDefinitionId),
    eq(questClassUnlocks.nodeId, opts.nodeId), eq(questClassUnlocks.optionId, opts.optionId),
  ));
  if (!unlock) throw httpError("Class option not found.", 404);
  if (!await hasPresentLivingClassMember({ teamId: player.teamId, requiredClass: unlock.requiredClass, worldObjectId: unlock.worldObjectId })) {
    throw httpError("The required living class member is not currently present at this location.", 403);
  }
  const [chosen] = await db.insert(questDialogueDecisions).values({
    questRunId: run.id, nodeId: opts.nodeId, optionId: opts.optionId,
    chosenByPlayerId: player.playerId,
  }).onConflictDoNothing().returning();
  if (!chosen) throw httpError("This dialogue node already has a binding team decision.", 409);
  return chosen;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Resolve accountId → { playerId, teamId, playerName }.
 * Throws a 404-shaped Error if no player record exists.
 */
async function resolvePlayer(accountId: string): Promise<{
  playerId: string;
  teamId: string;
  playerName: string;
}> {
  const rows = await db.execute<{
    player_id: string;
    team_id: string;
    username: string;
  }>(sql`
    SELECT p.id   AS player_id,
           p.team_id,
           a.username
    FROM   player  p
    JOIN   account a ON a.id = p.account_id
    WHERE  p.account_id = ${accountId}
  `);

  const row = (
    rows.rows as { player_id: string; team_id: string; username: string }[]
  )[0];

  if (!row) {
    const err = new Error(
      "No player record found for this account.",
    ) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  return {
    playerId: row.player_id,
    teamId: row.team_id,
    playerName: row.username,
  };
}

/**
 * Look up a WorldObject whose externalId matches the step's targetRef.
 *
 * GeoJSON seeds WorldObjects with Feature.id (e.g. "location:place_xyz"),
 * but QuestStep.targetRef stores only the candidateId ("place_xyz").
 * We try both the raw targetRef and the "location:" prefixed form.
 */
async function lookupWorldObjectByTargetRef(
  targetRef: string,
): Promise<(typeof worldObjects.$inferSelect) | null> {
  // Try direct match first (handles enemy_encounter refs like "enemy:UE-D1-01").
  let [wo] = await db
    .select()
    .from(worldObjects)
    .where(eq(worldObjects.externalId, targetRef));

  if (!wo) {
    // Try prefixed with "location:"
    [wo] = await db
      .select()
      .from(worldObjects)
      .where(eq(worldObjects.externalId, `location:${targetRef}`));
  }

  return wo ?? null;
}

/**
 * Build a QuestRunDetail from a raw quest_run row + definition metadata.
 * Loads all OBJECTIVE steps and their ObjectiveProgress records.
 */
async function buildQuestRunDetail(
  run: typeof questRuns.$inferSelect & {
    questTitle: string;
    questType: string;
    questDay: string | null;
  },
): Promise<QuestRunDetail> {
  // Load all OBJECTIVE-phase steps ordered by sequence
  const steps = await db
    .select()
    .from(questSteps)
    .where(
      and(
        eq(questSteps.questDefinitionId, run.questDefinitionId),
        eq(questSteps.flowPhase, "OBJECTIVE"),
      ),
    )
    .orderBy(questSteps.sequence);

  // Load existing ObjectiveProgress for this run
  const progressRows = await db
    .select()
    .from(objectiveProgress)
    .where(eq(objectiveProgress.questRunId, run.id));

  const progressMap = new Map(progressRows.map((p) => [p.objectiveId, p]));

  // Merge steps with progress
  const objectives = steps.map((step) => {
    const prog = progressMap.get(step.stepId);
    return {
      id: step.id,
      stepId: step.stepId,
      sequence: step.sequence,
      flowPhase: step.flowPhase as QuestStep["flowPhase"],
      stepActionType: step.stepActionType as QuestStep["stepActionType"],
      stepCategory: step.stepCategory,
      gddObjectiveType: step.gddObjectiveType,
      targetRef: step.targetRef,
      required: step.required,
      progress: prog
        ? {
            objectiveId: prog.objectiveId,
            status: prog.status as "PENDING" | "COMPLETED" | "SKIPPED",
            progressCount: prog.progressCount,
          }
        : null,
    };
  });

  // Current step = first required OBJECTIVE step that is not yet COMPLETED
  const currentStep =
    objectives.find((o) => {
      if (!o.required) return false;
      return !o.progress || o.progress.status === "PENDING";
    }) ?? null;

  // For REACH_LOCATION steps, enrich with the target WorldObject's name + coords
  // so the frontend can display navigation hints and a map marker.
  async function enrichWithTarget<T extends { stepActionType: string; targetRef: string }>(
    step: T,
  ): Promise<T & { targetObjectName?: string | null; targetLat?: number | null; targetLng?: number | null }> {
    if (step.stepActionType !== "REACH_LOCATION") return step;
    const wo = await lookupWorldObjectByTargetRef(step.targetRef);
    return {
      ...step,
      targetObjectName: wo?.name ?? null,
      targetLat: wo?.lat ?? null,
      targetLng: wo?.lng ?? null,
    };
  }

  const toIso = (v: unknown): string =>
    v instanceof Date ? v.toISOString() : String(v);

  const enrichedCurrentStep = currentStep ? await enrichWithTarget({
    id: currentStep.id,
    stepId: currentStep.stepId,
    sequence: currentStep.sequence,
    flowPhase: currentStep.flowPhase,
    stepActionType: currentStep.stepActionType,
    stepCategory: currentStep.stepCategory,
    gddObjectiveType: currentStep.gddObjectiveType,
    targetRef: currentStep.targetRef,
    required: currentStep.required,
  }) : null;

  return {
    id: run.id,
    teamId: run.teamId,
    questDefinitionId: run.questDefinitionId,
    state: run.state as QuestRunDetail["state"],
    startedAt: toIso(run.startedAt),
    completedAt: run.completedAt ? toIso(run.completedAt) : null,
    questTitle: run.questTitle,
    questType: run.questType as QuestRunDetail["questType"],
    questDay: run.questDay,
    currentStep: enrichedCurrentStep,
    objectives,
  };
}

// ── Internal: mark one objective step as COMPLETED ────────────────────────────

async function completeObjectiveStep(opts: {
  questRunId: string;
  stepId: string;
  stepActionType: string;
  run: typeof questRuns.$inferSelect;
  playerName: string;
  wsHub?: WsHub;
}): Promise<{ allRequiredDone: boolean }> {
  const { questRunId, stepId, stepActionType, run, playerName, wsHub } = opts;

  // Upsert ObjectiveProgress → COMPLETED
  await db
    .insert(objectiveProgress)
    .values({
      questRunId,
      objectiveId: stepId,
      status: "COMPLETED",
      progressCount: 1,
    })
    .onConflictDoUpdate({
      target: [objectiveProgress.questRunId, objectiveProgress.objectiveId],
      set: {
        status: sql`'COMPLETED'`,
        progressCount: sql`${objectiveProgress.progressCount} + 1`,
      },
    });

  // Load quest definition for title
  const [questDef] = await db
    .select({ title: questDefinitions.title })
    .from(questDefinitions)
    .where(eq(questDefinitions.id, run.questDefinitionId));

  // Re-check: are all required objectives completed now?
  const allSteps = await db
    .select({ step: questSteps, progress: objectiveProgress })
    .from(questSteps)
    .leftJoin(
      objectiveProgress,
      and(
        eq(objectiveProgress.questRunId, questRunId),
        eq(objectiveProgress.objectiveId, questSteps.stepId),
      ),
    )
    .where(
      and(
        eq(questSteps.questDefinitionId, run.questDefinitionId),
        eq(questSteps.flowPhase, "OBJECTIVE"),
        eq(questSteps.required, true),
      ),
    );

  const allRequiredDone = allSteps.every(
    (s) => s.progress?.status === "COMPLETED",
  );

  // Find the next pending step for the WS event payload
  const nextPendingRow = !allRequiredDone
    ? allSteps.find(
        (s) => !s.progress || s.progress.status === "PENDING",
      ) ?? null
    : null;

  const nextStep: QuestStep | null = nextPendingRow
    ? {
        id: nextPendingRow.step.id,
        stepId: nextPendingRow.step.stepId,
        sequence: nextPendingRow.step.sequence,
        flowPhase: nextPendingRow.step.flowPhase as QuestStep["flowPhase"],
        stepActionType:
          nextPendingRow.step.stepActionType as QuestStep["stepActionType"],
        stepCategory: nextPendingRow.step.stepCategory,
        gddObjectiveType: nextPendingRow.step.gddObjectiveType,
        targetRef: nextPendingRow.step.targetRef,
        required: nextPendingRow.step.required,
      }
    : null;

  // Broadcast quest.step_completed to all team members
  if (wsHub) {
    const event: QuestStepCompletedEvent = {
      event: "quest.step_completed",
      teamId: run.teamId,
      questRunId,
      questTitle: questDef?.title ?? "Quest",
      stepId,
      stepActionType: stepActionType as QuestStep["stepActionType"],
      completedByPlayerName: playerName,
      nextStep,
      timestamp: new Date().toISOString(),
    };
    wsHub.sendToTeam(run.teamId, event);
  }

  return { allRequiredDone };
}

// ── Public: getActiveRuns ─────────────────────────────────────────────────────

/**
 * Return all open QuestRuns for a team, including runs awaiting media review.
 */
export async function getActiveRuns(teamId: string): Promise<QuestRunDetail[]> {
  const rows = await db.execute<{
    id: string;
    team_id: string;
    quest_definition_id: string;
    state: string;
    started_at: Date;
    completed_at: Date | null;
    quest_title: string;
    quest_type: string;
    quest_day: string | null;
  }>(sql`
    SELECT qr.id,
           qr.team_id,
           qr.quest_definition_id,
           qr.state,
           qr.started_at,
           qr.completed_at,
           qd.title  AS quest_title,
           qd.type   AS quest_type,
           qd.day    AS quest_day
    FROM   quest_run        qr
    JOIN   quest_definition qd ON qd.id = qr.quest_definition_id
    WHERE  qr.team_id = ${teamId}
      AND  qr.state   IN ('ACTIVE', 'PENDING_REVIEW')
    ORDER  BY qr.started_at ASC
  `);

  const result: QuestRunDetail[] = [];

  for (const row of rows.rows as (typeof rows.rows)[number][]) {
    const r = row as {
      id: string;
      team_id: string;
      quest_definition_id: string;
      state: string;
      started_at: Date;
      completed_at: Date | null;
      quest_title: string;
      quest_type: string;
      quest_day: string | null;
    };

    result.push(
      await buildQuestRunDetail({
        id: r.id,
        teamId: r.team_id,
        questDefinitionId: r.quest_definition_id,
        state: r.state as "ACTIVE" | "PENDING_REVIEW",
        startedAt: r.started_at,
        acceptedAt: null, // ✅ FIX: Column doesn't exist in DB yet
        completedAt: r.completed_at,
        questTitle: r.quest_title,
        questType: r.quest_type,
        questDay: r.quest_day,
      }),
    );
  }

  return result;
}

// ── Public: getAvailableQuests ────────────────────────────────────────────────

/**
 * Return QuestDefinitions that at least one team member can currently discover
 * (proximity zone DISCOVERED or INTERACTING) and that the complete run history
 * allows under the QuestDefinition's repeatability policy.
 *
 * HIDDEN quests are included once the trigger WorldObject is in range
 * (they are filtered by type only in the active quest list UI, not here).
 */
export async function getAvailableQuests(
  teamId: string,
): Promise<QuestAvailable[]> {
  // Step 1: Player IDs for this team
  const teamPlayers = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.teamId, teamId));

  if (teamPlayers.length === 0) {
    return [];
  }

  const playerIds = teamPlayers.map((p) => p.id);

  // Step 2: WorldObjects in DISCOVERED or INTERACTING zone for any team member
  const proximityRows = await db
    .select({
      worldObjectId: playerProximityStates.worldObjectId,
      zone: playerProximityStates.zone,
    })
    .from(playerProximityStates)
    .where(
      and(
        inArray(playerProximityStates.playerId, playerIds),
        inArray(playerProximityStates.zone, ["DISCOVERED", "INTERACTING"]),
      ),
    );

  if (proximityRows.length === 0) {
    return [];
  }

  // Prefer INTERACTING over DISCOVERED if multiple team members see the same object
  const worldObjectZoneMap = new Map<string, string>();
  for (const row of proximityRows) {
    const existing = worldObjectZoneMap.get(row.worldObjectId);
    if (!existing || (existing === "DISCOVERED" && row.zone === "INTERACTING")) {
      worldObjectZoneMap.set(row.worldObjectId, row.zone);
    }
  }

  const nearbyObjectIds = [...worldObjectZoneMap.keys()];

  // Step 3: QuestDefinitions linked via QuestStation to these WorldObjects
  const stationRows = await db
    .select({
      questDefinitionId: questStations.questDefinitionId,
      worldObjectId: questStations.worldObjectId,
    })
    .from(questStations)
    .where(inArray(questStations.worldObjectId, nearbyObjectIds));

  if (stationRows.length === 0) {
    return [];
  }

  const questDefIds = [...new Set(stationRows.map((r) => r.questDefinitionId))];

  // Step 4: Load definitions and every prior run; repeatability is definition data.
  const questDefs = await db.select().from(questDefinitions)
    .where(inArray(questDefinitions.id, questDefIds));
  const priorRuns = await db
    .select({ questDefinitionId: questRuns.questDefinitionId, state: questRuns.state,
      startedAt: questRuns.startedAt, completedAt: questRuns.completedAt })
    .from(questRuns)
    .where(
      and(
        eq(questRuns.teamId, teamId),
        inArray(questRuns.questDefinitionId, questDefIds),
      ),
    );
  const now = new Date();
  const availableDefs = questDefs.filter((definition) => decideQuestAcceptance(
    priorRuns.filter((run) => run.questDefinitionId === definition.id), definition, now,
  ).allowed);

  if (availableDefs.length === 0) return [];

  // Step 6: Load WorldObject names for trigger objects
  const worldObjectRows = await db
    .select({ id: worldObjects.id, name: worldObjects.name })
    .from(worldObjects)
    .where(inArray(worldObjects.id, nearbyObjectIds));

  const worldObjectNameMap = new Map(worldObjectRows.map((r) => [r.id, r.name]));

  // Build result
  const result = availableDefs.map((qd): QuestAvailable => {
    const trigger = stationRows.find((s) => s.questDefinitionId === qd.id)!;
    const zone = worldObjectZoneMap.get(trigger.worldObjectId) ?? "DISCOVERED";

    return {
      questDefinitionId: qd.id,
      externalId: qd.externalId,
      title: qd.title,
      type: qd.type as QuestAvailable["type"],
      day: qd.day,
      discoveryPhase: zone === "INTERACTING" ? "DIALOGUE" : "DISCOVER",
      triggerObjectId: trigger.worldObjectId,
      triggerObjectName: worldObjectNameMap.get(trigger.worldObjectId) ?? "?",
    };
  });

  return result;
}

// ── Public: acceptQuest ───────────────────────────────────────────────────────

/**
 * Accept a quest for the team.
 *
 * - Enforces the 3-slot limit.
 * - Idempotent: returns the existing run if already accepted.
 * - Creates ObjectiveProgress rows for all OBJECTIVE steps.
 * - Broadcasts quest.accepted to all team members.
 */
export async function acceptQuest(opts: {
  accountId: string;
  questDefinitionId: string;
  wsHub?: WsHub;
}): Promise<{ run: QuestRunDetail; alreadyActive: boolean }> {
  const { accountId, questDefinitionId, wsHub } = opts;

  const { teamId, playerName } = await resolvePlayer(accountId);

  // Serialize all acceptances for a team. This makes both the 3-slot check and
  // the complete history/repeatability decision atomic across server instances.
  const accepted = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${teamId}, 0))`);

    const [questDef] = await tx.select().from(questDefinitions)
      .where(eq(questDefinitions.id, questDefinitionId));
    if (!questDef) throw httpError("Quest definition not found.", 404);

    const priorRuns = await tx.select().from(questRuns).where(and(
      eq(questRuns.teamId, teamId), eq(questRuns.questDefinitionId, questDefinitionId),
    ));
    const decision = decideQuestAcceptance(priorRuns, questDef, new Date());
    const existingRun = priorRuns.find((run) => run.state === "ACTIVE");
    if (existingRun) return { run: existingRun, questDef, alreadyActive: true };
    if (!decision.allowed) {
      const suffix = decision.reason === "COOLDOWN" && decision.retryAt
        ? ` Retry after ${decision.retryAt.toISOString()}.` : "";
      throw httpError(`Quest cannot be accepted (${decision.reason}).${suffix}`, 409);
    }

    const activeCountResult = await tx.select({ count: count() }).from(questRuns)
      .where(and(eq(questRuns.teamId, teamId), eq(questRuns.state, "ACTIVE")));
    if (Number(activeCountResult[0]?.count ?? 0) >= MAX_ACTIVE_QUESTS) {
      throw httpError(`Maximum ${MAX_ACTIVE_QUESTS} active quests per team. Finish one first.`, 409);
    }

    const [newRun] = await tx.insert(questRuns)
      .values({ teamId, questDefinitionId, state: "ACTIVE" }).returning();
    if (!newRun) throw new Error("Failed to create QuestRun.");

    const objectiveSteps = await tx.select().from(questSteps).where(and(
      eq(questSteps.questDefinitionId, questDefinitionId), eq(questSteps.flowPhase, "OBJECTIVE"),
    )).orderBy(questSteps.sequence);
    if (objectiveSteps.length > 0) {
      await tx.insert(objectiveProgress).values(objectiveSteps.map((step) => ({
        questRunId: newRun.id, objectiveId: step.stepId, status: "PENDING", progressCount: 0,
      })));
    }
    return { run: newRun, questDef, alreadyActive: false };
  });
  const { run: newRun, questDef, alreadyActive } = accepted;

  // Broadcast quest.accepted
  if (wsHub && !alreadyActive) {
    const event: QuestAcceptedEvent = {
      event: "quest.accepted",
      teamId,
      questRunId: newRun.id,
      questTitle: questDef.title,
      acceptedByPlayerName: playerName,
      timestamp: new Date().toISOString(),
    };
    wsHub.sendToTeam(teamId, event);
  }

  const detail = await buildQuestRunDetail({
    ...newRun,
    questTitle: questDef.title,
    questType: questDef.type,
    questDay: questDef.day,
  });

  return { run: detail, alreadyActive };
}

// ── Public: validateReachLocation ────────────────────────────────────────────

/**
 * Validate that the player is within the interaction radius of the OBJECTIVE
 * step's target location using PostGIS.
 *
 * On success: marks the step COMPLETED, broadcasts quest.step_completed.
 */
export async function validateReachLocation(opts: {
  accountId: string;
  questRunId: string;
  stepId: string;
  lat: number;
  lng: number;
  accuracy: number;
  wsHub?: WsHub;
}): Promise<StepResult> {
  const { accountId, questRunId, stepId, lat, lng, accuracy, wsHub } = opts;

  const { teamId, playerName } = await resolvePlayer(accountId);

  // Load QuestRun
  const [run] = await db
    .select()
    .from(questRuns)
    .where(
      and(
        eq(questRuns.id, questRunId),
        eq(questRuns.teamId, teamId),
        eq(questRuns.state, "ACTIVE"),
      ),
    );

  if (!run) {
    const err = new Error("QuestRun not found or not active.") as Error & {
      statusCode: number;
    };
    err.statusCode = 404;
    throw err;
  }

  // Load the target step
  const [step] = await db
    .select()
    .from(questSteps)
    .where(
      and(
        eq(questSteps.questDefinitionId, run.questDefinitionId),
        eq(questSteps.stepId, stepId),
        eq(questSteps.flowPhase, "OBJECTIVE"),
        eq(questSteps.stepActionType, "REACH_LOCATION"),
      ),
    );

  if (!step) {
    const err = new Error(
      "Step not found or not a REACH_LOCATION step.",
    ) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  // Verify this is the current active (pending) step
  const [currentProgress] = await db
    .select()
    .from(objectiveProgress)
    .where(
      and(
        eq(objectiveProgress.questRunId, questRunId),
        eq(objectiveProgress.objectiveId, stepId),
      ),
    );

  if (currentProgress?.status === "COMPLETED") {
    return {
      stepId,
      status: "COMPLETED",
      message: "Dieser Schritt ist bereits abgeschlossen.",
    };
  }

  // Look up the target WorldObject
  const targetObj = await lookupWorldObjectByTargetRef(step.targetRef);

  if (!targetObj || targetObj.lat == null || targetObj.lng == null) {
    const err = new Error("Target location not found or has no coordinates.") as Error & {
      statusCode: number;
    };
    err.statusCode = 404;
    throw err;
  }

  // PostGIS distance check
  const distCheck = await checkEffectiveDistance({
    playerLat: lat,
    playerLng: lng,
    targetLat: targetObj.lat,
    targetLng: targetObj.lng,
    accuracy,
    targetRadius: targetObj.interactionRadiusM,
  });

  if (!distCheck.withinRange) {
    const remaining = Math.ceil(
      distCheck.effectiveDistanceM - targetObj.interactionRadiusM,
    );
    return {
      stepId,
      status: "FAILED",
      message: `Noch ${remaining} m entfernt. Kommt näher!`,
    };
  }

  // Mark completed & broadcast
  const { allRequiredDone } = await completeObjectiveStep({
    questRunId,
    stepId,
    stepActionType: "REACH_LOCATION",
    run,
    playerName,
    ...(wsHub ? { wsHub } : {}),
  });

  return {
    stepId,
    status: "COMPLETED",
    message: "Standort bestätigt! ✓",
    questCompleted: allRequiredDone,
  };
}

// ── Public: submitAnswer ──────────────────────────────────────────────────────

/**
 * Validate a team's answer for an ANSWER_QUESTION or SOLVE_PUZZLE step.
 *
 * Team-sync check: when `requireAllMembersOnline` is true (and wsHub is
 * provided), all team members must be connected via WebSocket.
 *
 * Comparison is case-insensitive and ignores leading/trailing whitespace.
 */
export async function submitAnswer(opts: {
  accountId: string;
  questRunId: string;
  stepId: string;
  answer: string;
  wsHub?: WsHub;
  /** Enforce team-sync: all members must be online. */
  requireAllMembersOnline?: boolean;
}): Promise<StepResult> {
  const { accountId, questRunId, stepId, answer, wsHub, requireAllMembersOnline } =
    opts;

  const { teamId, playerName } = await resolvePlayer(accountId);

  // Load QuestRun
  const [run] = await db
    .select()
    .from(questRuns)
    .where(
      and(
        eq(questRuns.id, questRunId),
        eq(questRuns.teamId, teamId),
        eq(questRuns.state, "ACTIVE"),
      ),
    );

  if (!run) {
    const err = new Error("QuestRun not found or not active.") as Error & {
      statusCode: number;
    };
    err.statusCode = 404;
    throw err;
  }

  // Load the target step
  const [step] = await db
    .select()
    .from(questSteps)
    .where(
      and(
        eq(questSteps.questDefinitionId, run.questDefinitionId),
        eq(questSteps.stepId, stepId),
        eq(questSteps.flowPhase, "OBJECTIVE"),
        inArray(questSteps.stepActionType, ["ANSWER_QUESTION", "SOLVE_PUZZLE"]),
      ),
    );

  if (!step) {
    const err = new Error(
      "Step not found or not an answer step.",
    ) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  // Check if already completed
  const [currentProgress] = await db
    .select()
    .from(objectiveProgress)
    .where(
      and(
        eq(objectiveProgress.questRunId, questRunId),
        eq(objectiveProgress.objectiveId, stepId),
      ),
    );

  if (currentProgress?.status === "COMPLETED") {
    return {
      stepId,
      status: "COMPLETED",
      message: "Dieser Schritt ist bereits abgeschlossen.",
    };
  }

  // Team-sync check: all members must be connected
  if (requireAllMembersOnline && wsHub) {
    const memberCountResult = await db
      .select({ count: count() })
      .from(players)
      .where(eq(players.teamId, teamId));

    const connected = wsHub.getRoomStats()[teamId] ?? 0;
    const total = Number(memberCountResult[0]?.count ?? 0);

    if (connected < total) {
      return {
        stepId,
        status: "FAILED",
        message: `Alle ${total} Teammitglieder müssen online sein. Verbunden: ${connected}/${total}.`,
      };
    }
  }

  // Look up the QuestStation for expected answer.
  // Strategy 1: via WorldObject lookup (targetRef matches world_object.external_id)
  // Strategy 2: for virtual "OBS-..." refs, extract the trailing sequence number
  //             and look up the station by (quest_definition_id, sequence).
  const targetObj = await lookupWorldObjectByTargetRef(step.targetRef);

  let station: { expectedAnswer: string | null } | undefined;

  if (targetObj) {
    [station] = await db
      .select({ expectedAnswer: questStations.expectedAnswer })
      .from(questStations)
      .where(
        and(
          eq(questStations.worldObjectId, targetObj.id),
          eq(questStations.questDefinitionId, run.questDefinitionId),
        ),
      );
  } else {
    // Virtual station ref (e.g. "OBS-D1-Q01-1"): parse trailing number as station sequence.
    const seqMatch = step.targetRef.match(/(\d+)$/);
    const seqGroup = seqMatch?.[1];
    if (seqGroup !== undefined) {
      const stationSeq = parseInt(seqGroup, 10);
      [station] = await db
        .select({ expectedAnswer: questStations.expectedAnswer })
        .from(questStations)
        .where(
          and(
            eq(questStations.questDefinitionId, run.questDefinitionId),
            eq(questStations.sequence, stationSeq),
          ),
        );
    }
  }

  if (!station) {
    const err = new Error("Target location not found.") as Error & {
      statusCode: number;
    };
    err.statusCode = 404;
    throw err;
  }

  if (!station?.expectedAnswer) {
    const err = new Error(
      "No expected answer configured for this station.",
    ) as Error & { statusCode: number };
    err.statusCode = 500;
    throw err;
  }

  // Case-insensitive, trimmed comparison
  const normalised = (s: string) => s.trim().toLowerCase();
  if (normalised(answer) !== normalised(station.expectedAnswer)) {
    return {
      stepId,
      status: "FAILED",
      message: "Falsche Antwort. Versucht es nochmal! 🤔",
    };
  }

  // Correct – mark completed & broadcast
  const { allRequiredDone } = await completeObjectiveStep({
    questRunId,
    stepId,
    stepActionType: step.stepActionType,
    run,
    playerName,
    ...(wsHub ? { wsHub } : {}),
  });

  return {
    stepId,
    status: "COMPLETED",
    message: "Richtige Antwort! ✓",
    questCompleted: allRequiredDone,
  };
}

// ── Public: completeQuest ─────────────────────────────────────────────────────

/**
 * Finalise a QuestRun after all required objectives are done.
 *
 * Typically triggered by a TALK_TO_NPC interaction at the end NPC location
 * (flow_phase: COMPLETE). Marks the run COMPLETED, books rewards (stub for
 * Epic 6), and broadcasts quest.completed to all team members.
 */
export async function completeQuest(opts: {
  accountId: string;
  questRunId: string;
  wsHub?: WsHub;
}): Promise<{
  glory: number;
  denarii: number;
  items: { defKey: string; quantity: number; owner: "PLAYER" | "TEAM" }[];
  itemsSkipped: boolean;
}> {
  const { accountId, questRunId, wsHub } = opts;

  const { teamId, playerId } = await resolvePlayer(accountId);

  // Load QuestRun
  const [run] = await db
    .select()
    .from(questRuns)
    .where(
      and(
        eq(questRuns.id, questRunId),
        eq(questRuns.teamId, teamId),
        eq(questRuns.state, "ACTIVE"),
      ),
    );

  if (!run) {
    const err = new Error("QuestRun not found or not active.") as Error & {
      statusCode: number;
    };
    err.statusCode = 404;
    throw err;
  }

  // Guard: all required objectives must be done
  const allSteps = await db
    .select({ step: questSteps, progress: objectiveProgress })
    .from(questSteps)
    .leftJoin(
      objectiveProgress,
      and(
        eq(objectiveProgress.questRunId, questRunId),
        eq(objectiveProgress.objectiveId, questSteps.stepId),
      ),
    )
    .where(
      and(
        eq(questSteps.questDefinitionId, run.questDefinitionId),
        eq(questSteps.flowPhase, "OBJECTIVE"),
        eq(questSteps.required, true),
      ),
    );

  const incomplete = allSteps.filter(
    (s) => !s.progress || s.progress.status !== "COMPLETED",
  );

  if (incomplete.length > 0) {
    const err = new Error(
      `${incomplete.length} required objective(s) not yet completed.`,
    ) as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }

  const [questDef] = await db
    .select({ title: questDefinitions.title, type: questDefinitions.type, contentJson: questDefinitions.contentJson })
    .from(questDefinitions)
    .where(eq(questDefinitions.id, run.questDefinitionId));

  const chosenBonuses = await db.select({
    glory: questClassUnlocks.bonusGloryPercent,
    denarii: questClassUnlocks.bonusDenariiPercent,
  }).from(questDialogueDecisions).innerJoin(questClassUnlocks, and(
    eq(questClassUnlocks.questDefinitionId, run.questDefinitionId),
    eq(questClassUnlocks.nodeId, questDialogueDecisions.nodeId),
    eq(questClassUnlocks.optionId, questDialogueDecisions.optionId),
  )).where(eq(questDialogueDecisions.questRunId, questRunId));

  let authoredBonuses: Record<string, unknown> = {};
  try { authoredBonuses = JSON.parse(questDef?.contentJson ?? "{}") as Record<string, unknown>; } catch { /* invalid legacy content has no bonus */ }
  const otherGlory = Number(authoredBonuses.bonus_glory_percent ?? authoredBonuses.bonusGloryPercent ?? 0);
  const otherDenarii = Number(authoredBonuses.bonus_denarii_percent ?? authoredBonuses.bonusDenariiPercent ?? 0);
  const classGlory = chosenBonuses.reduce((sum, row) => sum + row.glory, 0);
  const classDenarii = chosenBonuses.reduce((sum, row) => sum + row.denarii, 0);
  // Runtime defence for legacy/imported rows: regular quest totals can never exceed 15%.
  const gloryPercent = questDef?.type === "REGULAR" ? Math.min(15, otherGlory + classGlory) : classGlory;
  const denariiPercent = questDef?.type === "REGULAR" ? Math.min(15, otherDenarii + classDenarii) : classDenarii;
  const rewardProfile = {
    ...QUEST_REWARD_PROFILE,
    fame: Math.round(QUEST_REWARD_PROFILE.fame * (1 + gloryPercent / 100)),
    denarii: Math.round(QUEST_REWARD_PROFILE.denarii * (1 + denariiPercent / 100)),
  };

  const granted = await grantRewards({
    seed: `quest-complete:${questRunId}`,
    teamId,
    playerId,
    profile: rewardProfile,
    source: "QUEST",
  });

  await db
    .update(questRuns)
    .set({ state: "COMPLETED", completedAt: new Date() })
    .where(eq(questRuns.id, questRunId));

  // Broadcast quest.completed to all team members
  if (wsHub) {
    const event: QuestCompletedEvent = {
      event: "quest.completed",
      teamId,
      questRunId,
      questTitle: questDef?.title ?? "Quest",
      rewardGlory: granted.glory,
      rewardDenarii: granted.denarii,
      timestamp: new Date().toISOString(),
    };
    wsHub.sendToTeam(teamId, event);
  }

  return granted;
}

// ── Public: getSingleRun ──────────────────────────────────────────────────────

/**
 * Return one QuestRun by ID (team-scoped).
 */
export async function getSingleRun(
  questRunId: string,
  teamId: string,
): Promise<QuestRunDetail | null> {
  const rows = await db.execute<{
    id: string;
    team_id: string;
    quest_definition_id: string;
    state: string;
    started_at: Date;
    completed_at: Date | null;
    quest_title: string;
    quest_type: string;
    quest_day: string | null;
  }>(sql`
    SELECT qr.id,
           qr.team_id,
           qr.quest_definition_id,
           qr.state,
           qr.started_at,
           qr.completed_at,
           qd.title  AS quest_title,
           qd.type   AS quest_type,
           qd.day    AS quest_day
    FROM   quest_run        qr
    JOIN   quest_definition qd ON qd.id = qr.quest_definition_id
    WHERE  qr.id      = ${questRunId}
      AND  qr.team_id = ${teamId}
  `);

  const row = (rows.rows as (typeof rows.rows)[number][])[0] as {
    id: string;
    team_id: string;
    quest_definition_id: string;
    state: string;
    started_at: Date;
    completed_at: Date | null;
    quest_title: string;
    quest_type: string;
    quest_day: string | null;
  } | undefined;

  if (!row) return null;

  return buildQuestRunDetail({
    id: row.id,
    teamId: row.team_id,
    questDefinitionId: row.quest_definition_id,
    state: row.state as "ACTIVE" | "PENDING_REVIEW" | "COMPLETED" | "FAILED",
    startedAt: row.started_at,
    acceptedAt: null, // ✅ FIX: Column doesn't exist in DB yet
    completedAt: row.completed_at,
    questTitle: row.quest_title,
    questType: row.quest_type,
    questDay: row.quest_day,
  });
}

// ── Public: resolveDefeatEnemy ────────────────────────────────────────────────

/**
 * Completes a DEFEAT_ENEMY objective (Epic 5 loot hook).
 * Full combat resolution stays Epic 6; this grants combat loot and marks the step done.
 */
export async function resolveDefeatEnemy(opts: {
  accountId: string;
  questRunId: string;
  stepId: string;
  wsHub?: WsHub;
}): Promise<StepResult> {
  const { accountId, questRunId, stepId, wsHub } = opts;
  const { teamId, playerId, playerName } = await resolvePlayer(accountId);

  const [run] = await db
    .select()
    .from(questRuns)
    .where(
      and(
        eq(questRuns.id, questRunId),
        eq(questRuns.teamId, teamId),
        eq(questRuns.state, "ACTIVE"),
      ),
    );

  if (!run) {
    const err = new Error("QuestRun not found or not active.") as Error & {
      statusCode: number;
    };
    err.statusCode = 404;
    throw err;
  }

  const [step] = await db
    .select()
    .from(questSteps)
    .where(
      and(
        eq(questSteps.questDefinitionId, run.questDefinitionId),
        eq(questSteps.stepId, stepId),
        eq(questSteps.flowPhase, "OBJECTIVE"),
        eq(questSteps.stepActionType, "DEFEAT_ENEMY"),
      ),
    );

  if (!step) {
    const err = new Error("Step not found or not a DEFEAT_ENEMY step.") as Error & {
      statusCode: number;
    };
    err.statusCode = 404;
    throw err;
  }

  const [currentProgress] = await db
    .select()
    .from(objectiveProgress)
    .where(
      and(
        eq(objectiveProgress.questRunId, questRunId),
        eq(objectiveProgress.objectiveId, stepId),
      ),
    );

  if (currentProgress?.status === "COMPLETED") {
    return {
      stepId,
      status: "COMPLETED",
      message: "Dieser Schritt ist bereits abgeschlossen.",
    };
  }

  const { allRequiredDone } = await completeObjectiveStep({
    questRunId,
    stepId,
    stepActionType: "DEFEAT_ENEMY",
    run,
    playerName,
    ...(wsHub ? { wsHub } : {}),
  });

  const granted = await grantRewards({
    seed: `combat-loot:${questRunId}:${stepId}`,
    teamId,
    playerId,
    profile: COMBAT_REWARD_PROFILE,
    source: "COMBAT",
  });

  const lootNote = granted.itemsSkipped
    ? " Inventar voll – Items konnten nicht aufgenommen werden."
    : granted.items.length > 0
      ? ` Beute: ${granted.items.map((i) => `${i.quantity}× ${i.defKey}`).join(", ")}.`
      : "";

  return {
    stepId,
    status: "COMPLETED",
    message: `Gegner besiegt! +${granted.glory} Ruhm, +${granted.denarii} Denare.${lootNote}`,
    questCompleted: allRequiredDone,
    rewards: { glory: granted.glory, denarii: granted.denarii },
  };
}
