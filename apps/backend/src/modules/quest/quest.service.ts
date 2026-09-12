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

import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  objectiveProgress,
  questDefinitions,
  questClassUnlocks,
  questDialogueDecisions,
  questRuns,
  questStations,
  questSteps,
  questStepWaypoints,
  questWaypointProgress,
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
  profileFromEncounterLabel,
} from "../economy/rewards.service.js";
import { getRuntimeEventState, questBelongsToDay, requireActiveEvent } from "../gm/event-runtime.service.js";
import { startPvECombat } from "../combat/combat.service.js";
import { decideQuestAcceptance } from "./quest-repeatability.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ACTIVE_QUESTS = 3;
const CLASS_PRESENCE_MAX_AGE_MS = 2 * 60 * 1000;
const PROXIMITY_MAX_AGE_MS = 2 * 60 * 1000;

type AuthoredDialogue = { sequenceId: string; nodeId: string; phase: string; order: number; speaker: string; mood?: string | null; text: string; options: Array<{ id: string; text: string; response: string; effect: Record<string, unknown> }>; defaultNext?: string | null };
type AuthoredTimer = { id: string; stepId: string; title: string; durationSec: number; startsWhen: string; warnings: number[]; onExpire: string; retryPolicy: string; uiComponent: string; safety: string };
type AuthoredQuest = { description?: string; questGiver?: string; slotRule?: string; reward?: { glory?: number; denarii?: number; itemRule?: string; profile?: string }; dialogues?: AuthoredDialogue[]; timers?: AuthoredTimer[] };
const authoredQuest = (value: unknown): AuthoredQuest => (value && typeof value === "object" ? value as AuthoredQuest : {});

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/** Delivers the exact quest-locked team item required by a USE_ITEM objective. */
export async function deliverQuestItem(opts:{accountId:string;questRunId:string;stepId:string;itemInstanceId:string;wsHub?:WsHub}) {
  const player=await resolvePlayer(opts.accountId);
  const [run]=await db.select().from(questRuns).where(and(eq(questRuns.id,opts.questRunId),
    eq(questRuns.teamId,player.teamId),eq(questRuns.state,"ACTIVE")));
  if(!run) throw httpError("QuestRun not found or not active.",404);
  await requireCurrentObjective(run,opts.stepId);
  const [step]=await db.select().from(questSteps).where(and(eq(questSteps.questDefinitionId,run.questDefinitionId),
    eq(questSteps.stepId,opts.stepId),eq(questSteps.stepActionType,"USE_ITEM")));
  if(!step) throw httpError("Step does not accept a quest item.",400);
  await db.transaction(async tx=>{
    const result=await tx.execute(sql`SELECT i.id item_id,i.quantity FROM item_instance i
      WHERE i.id=${opts.itemInstanceId}::uuid AND i.owner_type='TEAM' AND i.owner_id=${player.teamId}::uuid
        AND i.category='QUEST' AND i.is_quest_locked=true AND i.definition_id=${step.targetRef} FOR UPDATE`);
    const item=result.rows[0] as {item_id:string;quantity:number}|undefined;
    if(!item) throw httpError("Required quest item is unavailable",409);
    await tx.execute(sql`UPDATE item_instance SET quantity=quantity-1,is_quest_locked=false WHERE id=${item.item_id}::uuid`);
    await tx.execute(sql`DELETE FROM item_instance WHERE id=${item.item_id}::uuid AND quantity=0`);
    await tx.execute(sql`INSERT INTO objective_progress(quest_run_id,objective_id,status,progress_count)
      VALUES(${opts.questRunId}::uuid,${opts.stepId},'COMPLETED',1)
      ON CONFLICT(quest_run_id,objective_id) DO UPDATE SET status='COMPLETED',progress_count=1`);
  });
  const completed=await completeObjectiveStep({questRunId:run.id,stepId:step.stepId,
    stepActionType:step.stepActionType,run,playerName:player.playerName,skipProgressWrite:true,
    ...(opts.wsHub?{wsHub:opts.wsHub}:{})});
  return {status:"COMPLETED" as const,stepId:opts.stepId,message:"Questitem erfolgreich abgegeben. ✓",
    questCompleted:completed.allRequiredDone};
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
  // Try direct match first (handles refs that already carry a prefix like "enemy:UE-D1-01").
  let [wo] = await db
    .select()
    .from(worldObjects)
    .where(eq(worldObjects.externalId, targetRef));

  if (!wo) {
    // Try prefixed with "location:" (location_candidate features).
    [wo] = await db
      .select()
      .from(worldObjects)
      .where(eq(worldObjects.externalId, `location:${targetRef}`));
  }

  if (!wo) {
    // Try prefixed with "enemy:" (QUEST_ENEMY features store external_id as "enemy:<combat_profile_id>").
    [wo] = await db
      .select()
      .from(worldObjects)
      .where(eq(worldObjects.externalId, `enemy:${targetRef}`));
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
  await expireTimers(run);
  const [freshRun] = await db.select().from(questRuns).where(eq(questRuns.id, run.id));
  if (freshRun) run.runtimeState = freshRun.runtimeState;
  const [definition] = await db.select({ authoredContent: questDefinitions.authoredContent })
    .from(questDefinitions).where(eq(questDefinitions.id, run.questDefinitionId));
  const authored = authoredQuest(definition?.authoredContent);
  // Every authored objective counts, including COMPLETE_DIALOGUE outside the
  // literal OBJECTIVE flow phase.
  const steps = await db
    .select()
    .from(questSteps)
    .where(
      and(
        eq(questSteps.questDefinitionId, run.questDefinitionId),
        eq(questSteps.stepCategory, "OBJECTIVE"),
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
      ...(step.authoredContent as Record<string, unknown>),
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
  async function enrichWithTarget<T extends { id: string; stepActionType: string; targetRef: string }>(
    step: T,
  ): Promise<T & { targetObjectName?: string | null; targetLat?: number | null; targetLng?: number | null; waypoints?: Array<{ id: string; sequence: number; targetRef: string; name: string; lat: number | null; lng: number | null; visited: boolean }> }> {
    if (["NAVIGATION_CHALLENGE", "VISIT_MULTIPLE_LOCATIONS"].includes(step.stepActionType)) {
      const waypointRows = await db.select({ waypoint: questStepWaypoints, progress: questWaypointProgress })
        .from(questStepWaypoints).leftJoin(questWaypointProgress, and(
          eq(questWaypointProgress.questRunId, run.id), eq(questWaypointProgress.waypointId, questStepWaypoints.id),
        )).where(eq(questStepWaypoints.questStepId, step.id)).orderBy(questStepWaypoints.sequence);
      const waypoints = await Promise.all(waypointRows.map(async ({ waypoint, progress }) => {
        const target = await lookupWorldObjectByTargetRef(waypoint.targetRef);
        return { id: waypoint.id, sequence: waypoint.sequence, targetRef: waypoint.targetRef,
          name: target?.name ?? waypoint.targetRef, lat: target?.lat ?? null, lng: target?.lng ?? null, visited: Boolean(progress) };
      }));
      const next = waypoints.find((waypoint) => !waypoint.visited);
      return { ...step, waypoints, targetObjectName: next?.name ?? null, targetLat: next?.lat ?? null, targetLng: next?.lng ?? null };
    }
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
  const dialogues = await Promise.all((authored.dialogues ?? []).map(async (dialogue) => ({
    ...dialogue,
    options: (await Promise.all(dialogue.options.map(async (option) => {
      const requiredClass = option.effect["classCheck"];
      if (typeof requiredClass !== "string") return option;
      const step = steps.find((item) => item.targetRef === dialogue.sequenceId);
      const locationId = (step?.authoredContent as { locationId?: string } | undefined)?.locationId;
      const target = locationId ? await lookupWorldObjectByTargetRef(locationId) : null;
      return target && await hasPresentLivingClassMember({ teamId: run.teamId, requiredClass, worldObjectId: target.id }) ? option : null;
    }))).filter((option) => option !== null),
  })));

  const enrichedCurrentStep = currentStep ? await enrichWithTarget(currentStep) : null;

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
    runtimeState: run.runtimeState ?? {},
    reward: {
      glory: Number(authored.reward?.glory ?? 0),
      denarii: Number(authored.reward?.denarii ?? 0),
      itemRule: authored.reward?.itemRule ?? "",
    },
    slotRule: authored.slotRule ?? "",
    dialogues,
    timers: authored.timers ?? [],
  };
}

type TimerRuntime = { state: "RUNNING" | "COMPLETED" | "EXPIRED"; startedAt: string; deadlineAt: string; expiredAt?: string; resolvedBy?: string; consequence?: string };
const questTimerHandles = new Map<string, ReturnType<typeof setTimeout>>();
function armQuestTimer(run: typeof questRuns.$inferSelect, timerId: string, deadlineAt: string) {
  const key = `${run.id}:${timerId}`;
  const old = questTimerHandles.get(key); if (old) clearTimeout(old);
  const handle = setTimeout(() => void expireTimers(run).finally(() => questTimerHandles.delete(key)), Math.max(0, new Date(deadlineAt).getTime() - Date.now()) + 25);
  questTimerHandles.set(key, handle);
}

export async function recoverQuestTimers(): Promise<void> {
  const runs = await db.select().from(questRuns).where(eq(questRuns.state, "ACTIVE"));
  for (const run of runs) {
    await expireTimers(run);
    const timers = (run.runtimeState as { timers?: Record<string, TimerRuntime> }).timers ?? {};
    for (const [timerId, timer] of Object.entries(timers)) if (timer.state === "RUNNING") armQuestTimer(run, timerId, timer.deadlineAt);
  }
}
async function expireTimers(run: typeof questRuns.$inferSelect): Promise<void> {
  const state = { ...(run.runtimeState ?? {}) } as { timers?: Record<string, TimerRuntime>; [key: string]: unknown };
  if (!state.timers) return;
  let changed = false;
  const [definition] = await db.select({ authoredContent: questDefinitions.authoredContent }).from(questDefinitions).where(eq(questDefinitions.id, run.questDefinitionId));
  const definitions = authoredQuest(definition?.authoredContent).timers ?? [];
  for (const [timerId, timer] of Object.entries(state.timers)) {
    if (timer.state === "RUNNING" && new Date(timer.deadlineAt).getTime() <= Date.now()) {
      timer.state = "EXPIRED"; timer.expiredAt = new Date().toISOString(); timer.resolvedBy = "SERVER_DEADLINE"; changed = true;
      const authoredTimer = definitions.find((item) => item.id === timerId);
      state.timerEffects = { ...(state.timerEffects as Record<string, string> | undefined), [timerId]: authoredTimer?.onExpire ?? "" };
      if (authoredTimer?.onExpire.includes("AUTO_SELECT=")) {
        await db.insert(objectiveProgress).values({ questRunId: run.id, objectiveId: authoredTimer.stepId, status: "COMPLETED", progressCount: 1 })
          .onConflictDoUpdate({ target: [objectiveProgress.questRunId, objectiveProgress.objectiveId], set: { status: "COMPLETED", progressCount: 1 } });
        state.autoDecision = authoredTimer.onExpire.match(/AUTO_SELECT=([^;]+)/)?.[1] ?? "FALLBACK";
      }
    }
  }
  if (changed) await db.update(questRuns).set({ runtimeState: state }).where(eq(questRuns.id, run.id));
}

export async function startQuestTimer(opts: { accountId: string; questRunId: string; timerId: string }): Promise<QuestRunDetail> {
  const player = await resolvePlayer(opts.accountId);
  const [run] = await db.select().from(questRuns).where(and(eq(questRuns.id, opts.questRunId), eq(questRuns.teamId, player.teamId), eq(questRuns.state, "ACTIVE")));
  if (!run) throw httpError("QuestRun not found or not active.", 404);
  const [definition] = await db.select().from(questDefinitions).where(eq(questDefinitions.id, run.questDefinitionId));
  const timer = authoredQuest(definition?.authoredContent).timers?.find((item) => item.id === opts.timerId);
  if (!timer) throw httpError("Timer is not defined for this quest.", 404);
  await requireCurrentObjective(run, timer.stepId);
  const now = new Date(); const state = { ...(run.runtimeState ?? {}) } as { timers?: Record<string, TimerRuntime>; [key: string]: unknown };
  state.timers = { ...(state.timers ?? {}) };
  const prior = state.timers[timer.id];
  if (prior?.state === "RUNNING") return (await getSingleRun(run.id, player.teamId))!;
  if (prior && timer.retryPolicy.toUpperCase().includes("NO_")) throw httpError("This timer cannot be restarted.", 409);
  state.timers[timer.id] = { state: "RUNNING", startedAt: now.toISOString(), deadlineAt: new Date(now.getTime() + timer.durationSec * 1000).toISOString(), consequence: timer.onExpire };
  await db.update(questRuns).set({ runtimeState: state }).where(eq(questRuns.id, run.id));
  armQuestTimer({ ...run, runtimeState: state }, timer.id, state.timers[timer.id]!.deadlineAt);
  return (await getSingleRun(run.id, player.teamId))!;
}

export async function performQuestAction(opts: { accountId: string; questRunId: string; stepId: string; optionId?: string; wsHub?: WsHub }): Promise<StepResult> {
  const player = await resolvePlayer(opts.accountId);
  const [run] = await db.select().from(questRuns).where(and(eq(questRuns.id, opts.questRunId), eq(questRuns.teamId, player.teamId), eq(questRuns.state, "ACTIVE")));
  if (!run) throw httpError("QuestRun not found or not active.", 404);
  await requireCurrentObjective(run, opts.stepId);
  const [step] = await db.select().from(questSteps).where(and(eq(questSteps.questDefinitionId, run.questDefinitionId), eq(questSteps.stepId, opts.stepId)));
  if (!step || !["TALK_TO_NPC", "TEAM_DECISION", "CLASS_ACTION"].includes(step.stepActionType)) throw httpError("Step does not support a direct quest action.", 400);
  const [definition] = await db.select().from(questDefinitions).where(eq(questDefinitions.id, run.questDefinitionId));
  const dialogue = authoredQuest(definition?.authoredContent).dialogues?.find((item) => item.sequenceId === step.targetRef);
  const option = dialogue?.options.find((item) => item.id === opts.optionId);
  if (dialogue && !option) throw httpError("Choose a valid dialogue option.", 400);
  const classCheck = option?.effect["classCheck"];
  if (typeof classCheck === "string") {
    const locationId = (step.authoredContent as { locationId?: string }).locationId;
    const target = locationId ? await lookupWorldObjectByTargetRef(locationId) : null;
    if (!target || !await hasPresentLivingClassMember({ teamId: player.teamId, requiredClass: classCheck, worldObjectId: target.id })) throw httpError("The required living class member is not present.", 403);
  }
  const oldRuntime = run.runtimeState as { chosenEffects?: Record<string, unknown>[] };
  const runtime = { ...(run.runtimeState ?? {}),
    chosenEffects: option ? [...(oldRuntime.chosenEffects ?? []), option.effect] : (oldRuntime.chosenEffects ?? []),
    lastDialogue: dialogue ? { sequenceId: dialogue.sequenceId, nodeId: dialogue.nodeId, optionId: opts.optionId, response: option?.response } : undefined };
  await db.update(questRuns).set({ runtimeState: runtime }).where(eq(questRuns.id, run.id));
  const result = await completeObjectiveStep({ questRunId: run.id, stepId: step.stepId, stepActionType: step.stepActionType, run, playerName: player.playerName, ...(opts.wsHub ? { wsHub: opts.wsHub } : {}) });
  return { stepId: step.stepId, status: "COMPLETED", message: option?.response ?? "Schritt abgeschlossen. ✓", questCompleted: result.allRequiredDone };
}

// ── Internal: mark one objective step as COMPLETED ────────────────────────────

async function completeObjectiveStep(opts: {
  questRunId: string;
  stepId: string;
  stepActionType: string;
  run: typeof questRuns.$inferSelect;
  playerName: string;
  wsHub?: WsHub;
  skipProgressWrite?: boolean;
}): Promise<{ allRequiredDone: boolean }> {
  const { questRunId, stepId, stepActionType, run, playerName, wsHub } = opts;

  // Upsert ObjectiveProgress → COMPLETED
  if(!opts.skipProgressWrite) await db
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

  const [timerDefinition] = await db.select({ authoredContent: questDefinitions.authoredContent })
    .from(questDefinitions).where(eq(questDefinitions.id, run.questDefinitionId));
  const timer = authoredQuest(timerDefinition?.authoredContent).timers?.find((item) => item.stepId === stepId);
  if (timer) {
    const runtime = { ...(run.runtimeState ?? {}) } as { timers?: Record<string, TimerRuntime>; [key: string]: unknown };
    const active = runtime.timers?.[timer.id];
    if (active?.state === "RUNNING") {
      runtime.timers = { ...runtime.timers, [timer.id]: { ...active, state: "COMPLETED", resolvedBy: "OBJECTIVE_COMPLETED" } };
      await db.update(questRuns).set({ runtimeState: runtime }).where(eq(questRuns.id, run.id));
    }
  }

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
        eq(questSteps.stepCategory, "OBJECTIVE"),
        eq(questSteps.required, true),
      ),
    ).orderBy(questSteps.sequence);

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

async function requireCurrentObjective(run: typeof questRuns.$inferSelect, stepId: string) {
  await expireTimers(run);
  const rows = await db.select({ step: questSteps, progress: objectiveProgress })
    .from(questSteps).leftJoin(objectiveProgress, and(
      eq(objectiveProgress.questRunId, run.id), eq(objectiveProgress.objectiveId, questSteps.stepId),
    )).where(and(eq(questSteps.questDefinitionId, run.questDefinitionId),
      eq(questSteps.stepCategory, "OBJECTIVE"), eq(questSteps.required, true)))
    .orderBy(questSteps.sequence);
  const current = rows.find(({ progress }) => progress?.status !== "COMPLETED");
  if (!current || current.step.stepId !== stepId) {
    throw httpError(`Step ${stepId} is not the current quest objective.`, 409);
  }
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
    runtime_state: Record<string, unknown>;
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
           qr.runtime_state,
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
      runtime_state: Record<string, unknown>;
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
        runtimeState: r.runtime_state ?? {},
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
  const runtime = await getRuntimeEventState();
  if (runtime.state !== "ACTIVE") return [];
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
  let stationRows = await db
    .select({
      questDefinitionId: questStations.questDefinitionId,
      worldObjectId: questStations.worldObjectId,
      sequence: questStations.sequence,
    })
    .from(questStations)
    .where(inArray(questStations.worldObjectId, nearbyObjectIds));

  if (stationRows.length === 0) {
    return [];
  }
  const candidateIds = [...new Set(stationRows.map((row) => row.questDefinitionId))];
  const allStations = await db.select({ questDefinitionId: questStations.questDefinitionId, sequence: questStations.sequence })
    .from(questStations).where(inArray(questStations.questDefinitionId, candidateIds));
  const firstSequence = new Map<string, number>();
  for (const station of allStations) firstSequence.set(station.questDefinitionId, Math.min(firstSequence.get(station.questDefinitionId) ?? Infinity, station.sequence));
  stationRows = stationRows.filter((station) => station.sequence === firstSequence.get(station.questDefinitionId));
  if (stationRows.length === 0) return [];

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
  const availableDefs = questDefs.filter((definition) =>
    questBelongsToDay(definition.day, runtime.currentDay, definition.type) &&
    decideQuestAcceptance(priorRuns.filter((run) => run.questDefinitionId === definition.id), definition, now).allowed);

  if (availableDefs.length === 0) return [];

  // Step 6: Load WorldObject names for trigger objects
  const worldObjectRows = await db
    .select({ id: worldObjects.id, name: worldObjects.name })
    .from(worldObjects)
    .where(inArray(worldObjects.id, nearbyObjectIds));

  const worldObjectNameMap = new Map(worldObjectRows.map((r) => [r.id, r.name]));

  // Build result
  const result = await Promise.all(availableDefs.map(async (qd): Promise<QuestAvailable> => {
    const trigger = stationRows.find((s) => s.questDefinitionId === qd.id)!;
    const zone = worldObjectZoneMap.get(trigger.worldObjectId) ?? "DISCOVERED";

    const authored = authoredQuest(qd.authoredContent);
    const offer = authored.dialogues?.find((item) => item.phase === "OFFER") ?? null;
    const offerOptions = offer ? (await Promise.all(offer.options.map(async (option) => {
      const requiredClass = option.effect["classCheck"];
      if (typeof requiredClass !== "string") return option;
      return await hasPresentLivingClassMember({ teamId, requiredClass, worldObjectId: trigger.worldObjectId }) ? option : null;
    }))).filter((option) => option !== null) : [];
    return {
      questDefinitionId: qd.id,
      externalId: qd.externalId,
      title: qd.title,
      type: qd.type as QuestAvailable["type"],
      day: qd.day,
      discoveryPhase: zone === "INTERACTING" ? "DIALOGUE" : "DISCOVER",
      triggerObjectId: trigger.worldObjectId,
      triggerObjectName: worldObjectNameMap.get(trigger.worldObjectId) ?? "?",
      description: authored.description ?? "",
      questGiver: authored.questGiver ?? null,
      offerDialogue: offer ? {
        sequenceId: offer.sequenceId, nodeId: offer.nodeId, speaker: offer.speaker,
        mood: offer.mood ?? null, text: offer.text, options: offerOptions,
      } : null,
      reward: { glory: Number(authored.reward?.glory ?? 0), denarii: Number(authored.reward?.denarii ?? 0), itemRule: authored.reward?.itemRule ?? "" },
      slotRule: authored.slotRule ?? "",
    };
  }));

  return result;
}

// ── Public: getQuestMapLocations ──────────────────────────────────────────────

/**
 * Returns all quest start locations (first-station WorldObject coordinates)
 * for quests available to the team on the current game day that have not yet
 * been accepted or completed.
 *
 * Used by the frontend to show "where can I go to start a quest?" markers on
 * the map when the team has no active quest runs.
 */
export async function getQuestMapLocations(
  teamId: string,
): Promise<import("@jlw/contracts").QuestMapLocation[]> {
  const runtime = await getRuntimeEventState();
  if (runtime.state !== "ACTIVE") return [];

  // Step 1: All quest definitions that belong to the current game day
  const allDefs = await db.select().from(questDefinitions);
  const now = new Date();

  // Step 2: Prior runs for this team (needed for repeatability check)
  const allPriorRuns = await db
    .select({
      questDefinitionId: questRuns.questDefinitionId,
      state: questRuns.state,
      startedAt: questRuns.startedAt,
      completedAt: questRuns.completedAt,
    })
    .from(questRuns)
    .where(eq(questRuns.teamId, teamId));

  const eligibleDefs = allDefs.filter(
    (def) =>
      questBelongsToDay(def.day, runtime.currentDay, def.type) &&
      decideQuestAcceptance(
        allPriorRuns.filter((r) => r.questDefinitionId === def.id),
        def,
        now,
      ).allowed,
  );

  if (eligibleDefs.length === 0) return [];

  const eligibleIds = eligibleDefs.map((d) => d.id);

  // Step 3: First station (min sequence) per quest definition
  const allStations = await db
    .select({
      questDefinitionId: questStations.questDefinitionId,
      worldObjectId: questStations.worldObjectId,
      sequence: questStations.sequence,
    })
    .from(questStations)
    .where(inArray(questStations.questDefinitionId, eligibleIds));

  // Map: questDefinitionId → station with lowest sequence
  const firstStationMap = new Map<string, { worldObjectId: string; sequence: number }>();
  for (const station of allStations) {
    const existing = firstStationMap.get(station.questDefinitionId);
    if (!existing || station.sequence < existing.sequence) {
      firstStationMap.set(station.questDefinitionId, {
        worldObjectId: station.worldObjectId,
        sequence: station.sequence,
      });
    }
  }

  if (firstStationMap.size === 0) return [];

  // Step 4: Load WorldObject coordinates for all trigger objects
  const triggerObjectIds = [...new Set([...firstStationMap.values()].map((s) => s.worldObjectId))];
  const worldObjectRows = await db
    .select({
      id: worldObjects.id,
      name: worldObjects.name,
      lat: worldObjects.lat,
      lng: worldObjects.lng,
    })
    .from(worldObjects)
    .where(inArray(worldObjects.id, triggerObjectIds));

  const worldObjectMap = new Map(worldObjectRows.map((r) => [r.id, r]));

  // Step 5: Build result
  const result: import("@jlw/contracts").QuestMapLocation[] = [];
  for (const def of eligibleDefs) {
    const station = firstStationMap.get(def.id);
    if (!station) continue;
    const wo = worldObjectMap.get(station.worldObjectId);
    if (!wo) continue;

    result.push({
      questDefinitionId: def.id,
      externalId: def.externalId,
      title: def.title,
      type: def.type as import("@jlw/contracts").QuestMapLocation["type"],
      day: def.day,
      triggerObjectId: wo.id,
      triggerObjectName: wo.name,
      lat: wo.lat ?? null,
      lng: wo.lng ?? null,
    });
  }

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
  dialogueOptionId?: string;
}): Promise<{ run: QuestRunDetail; alreadyActive: boolean }> {
  const { accountId, questDefinitionId, wsHub, dialogueOptionId } = opts;

  const { teamId, playerName } = await resolvePlayer(accountId);

  // Serialize all acceptances for a team. This makes both the 3-slot check and
  // the complete history/repeatability decision atomic across server instances.
  const accepted = await db.transaction(async (tx) => {
    const runtime = await requireActiveEvent(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${teamId}, 0))`);

    const [questDef] = await tx.select().from(questDefinitions)
      .where(eq(questDefinitions.id, questDefinitionId));
    if (!questDef) throw httpError("Quest definition not found.", 404);
    if (!questBelongsToDay(questDef.day, runtime.currentDay, questDef.type)) {
      throw httpError(`Diese Quest ist an Tag ${runtime.currentDay} nicht freigeschaltet.`, 403);
    }

    const authored = authoredQuest(questDef.authoredContent);
    const offer = authored.dialogues?.find((item) => item.phase === "OFFER");
    if (offer && !offer.options.some((option) => option.id === dialogueOptionId)) {
      throw httpError("A valid quest-offer dialogue option is required.", 400);
    }
    const stations = await tx.select({ worldObjectId: questStations.worldObjectId, sequence: questStations.sequence })
      .from(questStations).where(eq(questStations.questDefinitionId, questDefinitionId)).orderBy(questStations.sequence);
    const startObjectIds = stations.length ? stations.filter((station) => station.sequence === stations[0]!.sequence).map((station) => station.worldObjectId) : [];
    const proximity = stations.length ? await tx.select({ id: playerProximityStates.playerId })
      .from(playerProximityStates).innerJoin(players, eq(players.id, playerProximityStates.playerId))
      .where(and(eq(players.accountId, accountId), inArray(playerProximityStates.worldObjectId, startObjectIds),
        eq(playerProximityStates.zone, "INTERACTING"),
        sql`${playerProximityStates.updatedAt} >= ${new Date(Date.now() - PROXIMITY_MAX_AGE_MS)}`)).limit(1) : [];
    if (stations.length && proximity.length === 0) throw httpError("Quest acceptance requires a current position inside the 15 m interaction radius.", 403);

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
      .innerJoin(questDefinitions, eq(questDefinitions.id, questRuns.questDefinitionId))
      .where(and(eq(questRuns.teamId, teamId), inArray(questRuns.state, ["ACTIVE", "PENDING_REVIEW"]), eq(questDefinitions.type, questDef.type)));
    if (questDef.type !== "HIDDEN" && Number(activeCountResult[0]?.count ?? 0) >= MAX_ACTIVE_QUESTS) {
      throw httpError(`Maximum ${MAX_ACTIVE_QUESTS} active quests per team. Finish one first.`, 409);
    }

    const [newRun] = await tx.insert(questRuns)
      .values({ teamId, questDefinitionId, state: "ACTIVE" }).returning();
    if (!newRun) throw new Error("Failed to create QuestRun.");

    const objectiveSteps = await tx.select().from(questSteps).where(and(
      eq(questSteps.questDefinitionId, questDefinitionId), eq(questSteps.stepCategory, "OBJECTIVE"),
    )).orderBy(questSteps.sequence);
    if (objectiveSteps.length > 0) {
      await tx.insert(objectiveProgress).values(objectiveSteps.map((step) => ({
        questRunId: newRun.id, objectiveId: step.stepId,
        status: step.flowPhase === "DIALOGUE" && step.sequence < (objectiveSteps.find((s) => s.flowPhase === "OBJECTIVE")?.sequence ?? Infinity) ? "COMPLETED" : "PENDING",
        progressCount: step.flowPhase === "DIALOGUE" ? 1 : 0,
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

  const { teamId, playerName, playerId } = await resolvePlayer(accountId);

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
  await requireCurrentObjective(run, stepId);

  // Load the target step
  const [step] = await db
    .select()
    .from(questSteps)
    .where(
      and(
        eq(questSteps.questDefinitionId, run.questDefinitionId),
        eq(questSteps.stepId, stepId),
        eq(questSteps.stepCategory, "OBJECTIVE"),
        inArray(questSteps.stepActionType, ["REACH_LOCATION", "NAVIGATION_CHALLENGE", "VISIT_MULTIPLE_LOCATIONS", "DEFEAT_ENEMY"]),
      ),
    );

  if (!step) {
    const err = new Error(
      "Step not found or not a location step.",
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

  const isCompound = step.stepActionType === "NAVIGATION_CHALLENGE" || step.stepActionType === "VISIT_MULTIPLE_LOCATIONS";
  const waypointRows = isCompound ? await db.select({ waypoint: questStepWaypoints, progress: questWaypointProgress })
    .from(questStepWaypoints).leftJoin(questWaypointProgress, and(
      eq(questWaypointProgress.questRunId, questRunId), eq(questWaypointProgress.waypointId, questStepWaypoints.id),
    )).where(eq(questStepWaypoints.questStepId, step.id)).orderBy(questStepWaypoints.sequence) : [];
  if (isCompound && waypointRows.length === 0) throw httpError("Compound location step has no persisted waypoints.", 500);
  // Navigation checkpoints are ordered. Multi-location visits accept any remaining location.
  let selectedWaypoint = isCompound
    ? (step.stepActionType === "NAVIGATION_CHALLENGE"
        ? (waypointRows.find(({ progress }) => !progress)?.waypoint ?? waypointRows.at(-1)?.waypoint)
        : undefined)
    : undefined;
  let targetObj = selectedWaypoint ? await lookupWorldObjectByTargetRef(selectedWaypoint.targetRef)
    : !isCompound ? await lookupWorldObjectByTargetRef(step.targetRef) : null;

  if (step.stepActionType === "VISIT_MULTIPLE_LOCATIONS") {
    let nearest: { waypoint: typeof questStepWaypoints.$inferSelect; target: typeof worldObjects.$inferSelect; distance: number } | undefined;
    for (const row of waypointRows.filter(({ progress }) => !progress)) {
      const candidate = await lookupWorldObjectByTargetRef(row.waypoint.targetRef);
      if (!candidate || candidate.lat == null || candidate.lng == null) continue;
      const distance = await checkEffectiveDistance({ playerLat: lat, playerLng: lng, targetLat: candidate.lat,
        targetLng: candidate.lng, accuracy, targetRadius: candidate.interactionRadiusM });
      if (distance.withinRange) { selectedWaypoint = row.waypoint; targetObj = candidate; break; }
      if (!nearest || distance.effectiveDistanceM < nearest.distance) nearest = { waypoint: row.waypoint, target: candidate, distance: distance.effectiveDistanceM };
    }
    if (!targetObj && nearest) { selectedWaypoint = nearest.waypoint; targetObj = nearest.target; }
  }

  if (!targetObj || targetObj.lat == null || targetObj.lng == null) {
    const err = new Error("Target location not found or has no coordinates.") as Error & {
      statusCode: number;
    };
    err.statusCode = 404;
    throw err;
  }
  const [storedPosition] = await db.select({ lat: players.lastLat, lng: players.lastLng,
    accuracy: players.lastAccuracy, updatedAt: players.lastLocationUpdate }).from(players).where(eq(players.id, playerId));
  if (!storedPosition?.updatedAt || Date.now() - storedPosition.updatedAt.getTime() > PROXIMITY_MAX_AGE_MS ||
      storedPosition.lat == null || storedPosition.lng == null || storedPosition.accuracy == null ||
      Math.abs(storedPosition.lat - lat) > 0.0002 || Math.abs(storedPosition.lng - lng) > 0.0002) {
    throw httpError("A fresh server-confirmed GPS position is required.", 403);
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

  if (isCompound && selectedWaypoint) {
    await db.insert(questWaypointProgress).values({ questRunId, waypointId: selectedWaypoint.id, visitedByPlayerId: playerId })
      .onConflictDoNothing({ target: [questWaypointProgress.questRunId, questWaypointProgress.waypointId] });
    const visitCounts = await db.select({ visited: count() }).from(questWaypointProgress)
      .innerJoin(questStepWaypoints, eq(questWaypointProgress.waypointId, questStepWaypoints.id))
      .where(and(eq(questWaypointProgress.questRunId, questRunId), eq(questStepWaypoints.questStepId, step.id)));
    const visited = Number(visitCounts[0]?.visited ?? 0);
    await db.update(objectiveProgress).set({ progressCount: Number(visited) })
      .where(and(eq(objectiveProgress.questRunId, questRunId), eq(objectiveProgress.objectiveId, stepId)));
    if (Number(visited) < waypointRows.length) return { stepId, status: "PENDING",
      message: `Wegpunkt bestätigt (${visited}/${waypointRows.length}).`, questCompleted: false };
  }

  const requiredMembers = Number((step.authoredContent as { successCondition?: string }).successCondition?.match(/teamMembersInRadius\s*>=\s*(\d+)/)?.[1] ?? 1);
  if (requiredMembers > 1) {
    const present = await db.select({ id: players.id }).from(players)
      .innerJoin(playerProximityStates, eq(playerProximityStates.playerId, players.id))
      .where(and(eq(players.teamId, teamId), eq(players.status, "ACTIVE"), sql`${players.hpCurrent} > 0`,
        eq(playerProximityStates.worldObjectId, targetObj.id),
        inArray(playerProximityStates.zone, ["INTERACTING", "AGGRO", "BOSS_JOIN"]),
        sql`${playerProximityStates.updatedAt} >= ${new Date(Date.now() - PROXIMITY_MAX_AGE_MS)}`));
    if (present.length < requiredMembers) return { stepId, status: "FAILED", message: `${requiredMembers} lebende Teammitglieder müssen gemeinsam im Interaktionsradius sein (${present.length}/${requiredMembers}).` };
  }

  if (isCompound) await db.update(objectiveProgress).set({ status: "COMPLETED", progressCount: waypointRows.length })
    .where(and(eq(objectiveProgress.questRunId, questRunId), eq(objectiveProgress.objectiveId, stepId)));

  // Mark completed & broadcast
  const { allRequiredDone } = await completeObjectiveStep({
    questRunId,
    stepId,
    stepActionType: step.stepActionType,
    run,
    playerName,
    skipProgressWrite: isCompound,
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
  await requireCurrentObjective(run, stepId);

  // Load the target step
  const [step] = await db
    .select()
    .from(questSteps)
    .where(
      and(
        eq(questSteps.questDefinitionId, run.questDefinitionId),
        eq(questSteps.stepId, stepId),
        eq(questSteps.stepCategory, "OBJECTIVE"),
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

  const puzzle = (step.authoredContent as { puzzle?: { expectedAnswer?: string; acceptedVariants?: string[] } }).puzzle;
  const acceptedAnswers = [puzzle?.expectedAnswer, ...(puzzle?.acceptedVariants ?? []), station?.expectedAnswer]
    .filter((value): value is string => Boolean(value));

  // Only throw 404 if there's truly no answer source at all (neither station nor authored_content).
  // Hidden quests and virtual steps may have no station but carry answers in authored_content.
  if (!station && acceptedAnswers.length === 0) {
    const err = new Error("Target location not found.") as Error & {
      statusCode: number;
    };
    err.statusCode = 404;
    throw err;
  }

  if (acceptedAnswers.length === 0) {
    const err = new Error(
      "No expected answer configured for this station.",
    ) as Error & { statusCode: number };
    err.statusCode = 500;
    throw err;
  }

  // Case-insensitive, trimmed comparison
  const normalised = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ").trim().toLowerCase();
  if (!acceptedAnswers.some((candidate) => normalised(answer) === normalised(candidate))) {
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

  const [definitionForItem] = await db.select({ authoredContent: questDefinitions.authoredContent }).from(questDefinitions).where(eq(questDefinitions.id, run.questDefinitionId));
  const itemKey = authoredQuest(definitionForItem?.authoredContent).reward?.itemRule?.match(/QUEST_ITEM:([a-z0-9_]+)/i)?.[1];
  if (itemKey && step.stepActionType === "SOLVE_PUZZLE") {
    await grantRewards({ seed: `quest-item:${questRunId}:${itemKey}`, teamId, playerId: (await resolvePlayer(accountId)).playerId,
      profile: { fame: 0, denarii: 0, playerItems: [], teamItems: [{ defKey: itemKey, quantity: 1 }] }, source: "QUEST" });
  }

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
      ),
    );

  if (!run) {
    const err = new Error("QuestRun not found or not active.") as Error & {
      statusCode: number;
    };
    err.statusCode = 404;
    throw err;
  }
  if (run.state === "COMPLETED") {
    const previous = (run.runtimeState as { rewardResult?: { glory: number; denarii: number; items: { defKey: string; quantity: number; owner: "PLAYER" | "TEAM" }[]; itemsSkipped: boolean } }).rewardResult;
    if (previous) return previous;
    throw httpError("Completed quest has no recoverable reward snapshot.", 409);
  }
  if (run.state !== "ACTIVE") throw httpError("Quest is awaiting review or failed.", 409);

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
        eq(questSteps.stepCategory, "OBJECTIVE"),
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
    .select({ title: questDefinitions.title, type: questDefinitions.type, contentJson: questDefinitions.contentJson, authoredContent: questDefinitions.authoredContent })
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
  const runtimeEffects = ((run.runtimeState as { chosenEffects?: Record<string, unknown>[] }).chosenEffects ?? []);
  const authoredClassDenarii = runtimeEffects.some((effect) => effect["bonusDenarii"] === true) ? 15 : 0;
  // Runtime defence for legacy/imported rows: regular quest totals can never exceed 15%.
  const gloryPercent = questDef?.type === "REGULAR" ? Math.min(15, otherGlory + classGlory) : classGlory;
  const denariiPercent = questDef?.type === "REGULAR" ? Math.min(15, otherDenarii + classDenarii + authoredClassDenarii) : classDenarii + authoredClassDenarii;
  const authoredReward = authoredQuest(questDef?.authoredContent).reward;
  const itemRule = authoredReward?.itemRule ?? "";
  const standardLoot = itemRule.startsWith("LOOT_ROLL:QUEST_STANDARD")
    ? profileFromEncounterLabel(authoredReward?.profile)
    : null;
  const rewardProfile = {
    fame: Math.round(Number(authoredReward?.glory ?? QUEST_REWARD_PROFILE.fame) * (1 + gloryPercent / 100)),
    denarii: Math.round(Number(authoredReward?.denarii ?? QUEST_REWARD_PROFILE.denarii) * (1 + denariiPercent / 100)),
    // GDD 9.6/9.8: normal quest loot lands in the shared team inventory.
    // QUEST_ITEM rules are intermediate locked objective items and are granted
    // by submitAnswer, not duplicated as completion loot.
    playerItems: [],
    teamItems: standardLoot ? [...standardLoot.playerItems, ...standardLoot.teamItems] : [],
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
    .set({ state: "COMPLETED", completedAt: new Date(), runtimeState: { ...(run.runtimeState ?? {}), rewardResult: granted } })
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
    runtime_state: Record<string, unknown>;
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
           qr.runtime_state,
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
    runtime_state: Record<string, unknown>;
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
    runtimeState: row.runtime_state ?? {},
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

// ── Public: engageEnemy ───────────────────────────────────────────────────────

/**
 * Manually starts a PvE combat for a DEFEAT_ENEMY quest step.
 * Used when the player taps "Kampf starten" instead of triggering via proximity.
 */
export async function engageEnemy(opts: {
  accountId: string;
  questRunId: string;
  stepId: string;
  wsHub?: WsHub;
}): Promise<{ combatId: string }> {
  const { accountId, questRunId, stepId, wsHub } = opts;
  const { teamId } = await resolvePlayer(accountId);

  // Verify quest run belongs to team and is active
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
    const err = new Error("QuestRun not found or not active.") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  // Get the DEFEAT_ENEMY step
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
    const err = new Error("Step not found or not a DEFEAT_ENEMY step.") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  if (!step.targetRef) {
    const err = new Error("Step has no target_ref configured.") as Error & { statusCode: number };
    err.statusCode = 500;
    throw err;
  }

  // Check step not already completed
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
    const err = new Error("Dieser Schritt ist bereits abgeschlossen.") as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }

  // Find the enemy world object by target_ref (flexible: with or without "enemy:" prefix)
  const targetRef = step.targetRef;
  const [enemyObj] = await db
    .select({ id: worldObjects.id })
    .from(worldObjects)
    .where(
      and(
        eq(worldObjects.type, "ENEMY"),
        or(
          eq(worldObjects.externalId, targetRef),
          eq(worldObjects.externalId, `enemy:${targetRef}`),
          eq(worldObjects.externalId, targetRef.replace(/^enemy:/, "")),
        ),
      ),
    );

  if (!enemyObj) {
    const err = new Error(`Enemy world object not found for target_ref: ${targetRef}`) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  // Start the PvE combat
  const combat = await startPvECombat({
    teamId,
    enemyWorldObjectId: enemyObj.id,
    ...(wsHub ? { wsHub } : {}),
  });

  return { combatId: combat.id };
}
