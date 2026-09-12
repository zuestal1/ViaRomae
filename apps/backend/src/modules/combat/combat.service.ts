/**
 * Combat Service (Epic 6)
 * PvE & PvP turn-based combat system with state machine.
 */
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  combatInstances,
  combatants,
  combatActions,
  combatActionSubmissions,
  combatAbilityCooldowns,
  combatEffects,
  combatRoundOrders,
  combatThreat,
  pvpChallenges,
  pvpProtections,
  statusEffectInstances,
  statusEffectDefinitions,
} from "../../db/schema/combat.js";
import { players, teams } from "../../db/schema/player.js";
import { worldObjects } from "../../db/schema/world.js";
import { ledgerEntries } from "../../db/schema/economy.js";
import type { WsHub } from "../ws/ws.hub.js";
import { randomInt, randomUUID } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import {
  calculateDamage as calculateCombatDamage,
  calculateEffectiveInitiative,
  compareRoundOrder,
  calculateEquipmentRarityScore,
  calculateHealing,
  calculateGeneratedThreat,
  selectThreatTarget,
  clampCombatPercent,
  type CombatStats,
  type EquipmentRarity,
} from "./combat-calculation.js";
import type { ClassId } from "@jlw/contracts";
import { ABILITY_DEFINITIONS, CLASS_LOADOUTS, type AbilityDefinition, type AbilityId } from "@jlw/contracts";
import type { StatusEffect } from "@jlw/contracts";
import { materializeHealthRegeneration, markTeamRegenStopped } from "./health-regeneration.service.js";
import { getPlayerStats } from "../player/player-stats.service.js";
import { resolveCombatConsumable } from "../economy/consumable.service.js";
import { effectiveItemStats } from "../economy/item-rules.js";
import { resolveDefeatEnemy } from "../quest/quest.service.js";
import { abilitiesForClass, CLASS_ABILITY_CLASSES } from "../classes/class-rules.js";
import { requireActiveEvent } from "../gm/event-runtime.service.js";
import { hasOpponentPhaseCompleted, isOpponentPhaseEffectActive,
  nextCompleteOpponentPhase } from "./combat-effect-lifetime.js";

// ── Constants ────────────────────────────────────────────────────────────────

const ROUND_TIMER_MS = 15_000; // 15 seconds per round
const PVP_WARNING_TIMER_MS = 20_000; // 20 seconds warning before PvP
const PVP_AGGRO_RADIUS_M = 20;
const PVP_VISIBILITY_RADIUS_M = 60;
const PVP_ESCAPE_RADIUS_M = 30;
const PVP_PROTECTION_MS = 60 * 60 * 1_000;
const COMBAT_UUID_NAMESPACE = "91dca435-5a22-4f53-a5f8-6a26013121b6";

function newRoundTiming(now = new Date()) {
  return { roundStartedAt: now, actionDeadline: new Date(now.getTime() + ROUND_TIMER_MS) };
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface CombatInstance {
  id: string;
  type: "PVE" | "PVP" | "BOSS";
  state: "INITIALIZING" | "AWAITING_ACTIONS" | "LOCKED" | "RESOLVING" | "COMPLETED";
  roundNumber: number;
  startedAt: Date;
  combatants: Combatant[];
  actions: CombatAction[];
  threat: CombatThreat[];
  actionDeadline?: Date;
}

export interface Combatant {
  id: string;
  entityType: "PLAYER" | "ENEMY";
  entityId: string;
  teamId?: string | undefined;
  hpCurrent: number;
  hpMax: number;
  atk: number;
  def: number;
  initiative: number;
  attack?: number;
  defense?: number;
  initiativeTieBreaker?: number;
  stats?: CombatStats;
  equipmentRarityScore?: number;
  lastTargetId?: string;
  modeMultiplier?: number;
  name: string;
  isDowned: boolean;
  abilityDefinitions?: AbilityDefinition[];
  abilityCooldowns?: Partial<Record<AbilityId, number>>;
  class?: string;
  shield: number;
  statusEffects: StatusEffect[];
  abilities?: AbilityDefinition[];
  enemyBehavior?: {
    type: string;
    powerAttackEvery: number;
    powerAttackMultiplier: number;
    targetStrategy: "THREAT" | "HIGHEST_ATTACK" | "LOWEST_HP" | "LOWEST_DEFENSE";
  };
}

export interface CombatAction {
  id: string;
  roundNumber: number;
  actorId: string;
  actionType: ActionType;
  abilityId?: AbilityId | undefined;
  targetId?: string | undefined;
  isLocked: boolean;
  origin: "PLAYER_SUBMITTED" | "AUTOMATIC" | "ENEMY_AI";
  damage?: number;
  effect?: string;
}

export interface CombatThreat {
  enemyCombatantId: string;
  playerCombatantId: string;
  amount: number;
}

export type ActionType = "ATTACK" | "SKILL" | "DEFEND";

export interface CombatLog {
  timestamp: Date;
  message: string;
  type: "ACTION" | "DAMAGE" | "EFFECT" | "STATE";
}

async function loadPlayerProfile(playerId: string, base: { atk: number; def: number; initiative: number }): Promise<{
  stats: CombatStats;
  equipmentRarityScore: number;
}> {
  const result = await db.execute<{ stats: string; slot: string;rarity:EquipmentRarity }>(sql`
    SELECT d.stats, i.slot,d.rarity FROM item_instance i
    JOIN item_def d ON d.key = i.definition_id
    WHERE i.owner_id = ${playerId} AND i.is_equipped = true
    ORDER BY i.slot, i.id
    LIMIT 4
  `);
  const stats: CombatStats = { attack: base.atk, defense: base.def, initiative: base.initiative };
  const rarities: EquipmentRarity[] = [];
  for (const item of result.rows) {
    const modifiers = effectiveItemStats(item.stats,item.rarity) as Record<string, number>;
    // Base/equipment values are already included by getPlayerStats. Only combat-only
    // modifier fields and rarity are read here.
    stats.damageDealtPercent = (stats.damageDealtPercent ?? 0) + Number(modifiers.damageDealtPercent ?? 0);
    stats.defensePercent = (stats.defensePercent ?? 0) + Number(modifiers.defensePercent ?? 0);
    stats.defenseFlat = (stats.defenseFlat ?? 0) + Number(modifiers.defenseFlat ?? 0);
    stats.damageTakenPercent = (stats.damageTakenPercent ?? 0) + Number(modifiers.damageTakenPercent ?? 0);
    stats.initiativePercent = (stats.initiativePercent ?? 0) + Number(modifiers.initiativePercent ?? 0);
    stats.initiativeFlat = (stats.initiativeFlat ?? 0) + Number(modifiers.initiativeFlat ?? 0);
    stats.healingPercent = (stats.healingPercent ?? 0) + Number(modifiers.healingPercent ?? 0);
    stats.armorBreakPercentPoints=(stats.armorBreakPercentPoints??0)+Number(modifiers.armorBreakPercentPoints??0);
    rarities.push(item.rarity);
  }
  return { stats, equipmentRarityScore: calculateEquipmentRarityScore(rarities) };
}

// ── PvE Encounter Management ─────────────────────────────────────────────────

/**
 * Starts a PvE combat instance when a team enters enemy_aggro_radius_m
 * with an active DEFEAT_ENEMY quest step.
 */
export async function startPvECombat(opts: {
  teamId: string;
  enemyWorldObjectId: string;
  wsHub?: WsHub;
}): Promise<CombatInstance> {
  await requireActiveEvent();
  const { teamId, enemyWorldObjectId, wsHub } = opts;
  await markTeamRegenStopped(teamId);

  // Check if combat already exists for this team
  const existingCombat = await getActiveCombatForTeam(teamId);
  if (existingCombat) {
    throw new Error("Team is already in combat");
  }

  // Get enemy data
  const [enemy] = await db
    .select()
    .from(worldObjects)
    .where(eq(worldObjects.id, enemyWorldObjectId));

  if (!enemy || enemy.type !== "ENEMY") {
    throw new Error("Invalid enemy encounter");
  }

  // Get team players
  const teamPlayers = await db
    .select()
    .from(players)
    .where(eq(players.teamId, teamId));

  if (teamPlayers.length === 0) {
    throw new Error("Team has no players");
  }

  // Create combat instance
  const combatResults = await db
    .insert(combatInstances)
    .values({
      type: "PVE",
      state: "INITIALIZING",
      roundNumber: 0,
    })
    .returning();

  const combat = combatResults[0];
  if (!combat) {
    throw new Error("Failed to create combat instance");
  }

  // Create combatants for players
  const playerCombatants = await Promise.all(
    teamPlayers.map(async (player) => {
      const stats = await getPlayerStats(player);
      const rawHp = Math.min(player.hpCurrent, stats.hpMax);
      const hpCurrent = Number.isFinite(rawHp) && rawHp > 0 ? rawHp : player.hpCurrent || 100;
      const results = await db
        .insert(combatants)
        .values({
          combatInstanceId: combat.id,
          entityType: "PLAYER",
          entityId: player.id,
          teamId: player.teamId,
          hpCurrent,
        })
        .returning();
      const combatant = results[0];
      if (!combatant) throw new Error("Failed to create player combatant");
      return combatant;
    })
  );

  // Create enemy combatant
  // Parse enemy stats from rawPropertiesJson
  const enemyProps = enemy.rawPropertiesJson
    ? JSON.parse(enemy.rawPropertiesJson)
    : {};
  const enemyHp = enemyProps.hp ?? 100;

  const enemyResults = await db
    .insert(combatants)
    .values({
      combatInstanceId: combat.id,
      entityType: "ENEMY",
      entityId: enemy.id,
      hpCurrent: enemyHp,
    })
    .returning();

  const enemyCombatant = enemyResults[0];
  if (!enemyCombatant) {
    throw new Error("Failed to create enemy combatant");
  }

  // Start round 1
  await db
    .update(combatInstances)
    .set({
      state: "AWAITING_ACTIONS",
      roundNumber: 1,
      ...newRoundTiming(),
    })
    .where(eq(combatInstances.id, combat.id));

  // Schedule auto-lock after ROUND_TIMER_MS
  scheduleRoundLock(combat.id, ROUND_TIMER_MS, wsHub);

  // Emit WS event
  if (wsHub) {
    wsHub.sendToTeam(teamId, {
      event: "combat:started",
      data: { combatId: combat.id, type: "PVE", enemyName: enemy.name },
    });
  }

  return getCombatInstance(combat.id);
}

/**
 * Get full combat instance with combatants and actions.
 */
export async function getCombatInstance(combatId: string): Promise<CombatInstance> {
  const [combat] = await db
    .select()
    .from(combatInstances)
    .where(eq(combatInstances.id, combatId));

  if (!combat) {
    throw new Error("Combat not found");
  }

  const combatantsData = await db
    .select()
    .from(combatants)
    .where(eq(combatants.combatInstanceId, combatId));

  const actionsData = await db
    .select()
    .from(combatActions)
    .where(eq(combatActions.combatInstanceId, combatId));
  const threatData = await db.select().from(combatThreat)
    .where(eq(combatThreat.combatInstanceId, combatId));
  const abilityCooldownData = await db.select().from(combatAbilityCooldowns)
    .where(eq(combatAbilityCooldowns.combatInstanceId, combatId));
  const effectsData = await db.select().from(statusEffectInstances)
    .where(eq(statusEffectInstances.combatInstanceId, combatId));
  const combatEffectsData = await db.select().from(combatEffects)
    .where(eq(combatEffects.combatInstanceId, combatId));

  const enrichedCombatants: Combatant[] = await Promise.all(combatantsData.map(async (c) => {
    let name = "Unknown";
    let hpMax = 100;
    let atk = 10;
    let def = 0;
    let initiative = 0;
    let enemyBehavior: Combatant["enemyBehavior"];
    let playerClass: ClassId | undefined;
    let profile: { stats: CombatStats; equipmentRarityScore: number } = {
      stats: { attack: 10, defense: 0, initiative: 0 }, equipmentRarityScore: 0 };

    if (c.entityType === "PLAYER") {
      const [player] = await db.select().from(players).where(eq(players.id, c.entityId));
      if (player?.class) {
        playerClass = player.class;
        name = player.playerName ?? player.accountId.substring(0, 8);
        const stats = await getPlayerStats(player);
        ({ hpMax, atk, def, initiative } = stats);
        profile = await loadPlayerProfile(c.entityId, { atk, def, initiative });
      }
    } else {
      const [enemy] = await db.select().from(worldObjects).where(eq(worldObjects.id, c.entityId));
      name = enemy?.name ?? "Enemy";
      const props = enemy?.rawPropertiesJson ? JSON.parse(enemy.rawPropertiesJson) : {};
      enemyBehavior = props.behavior as Combatant["enemyBehavior"];
      const bossDefaults = combat.type === "BOSS"
        ? (enemy?.day === "DAY_2" || enemy?.day === "2" ? { hp: 3240, def: 30, initiative: 11 } : { hp: 2160, def: 24, initiative: 9 })
        : { hp: 100, def: 0, initiative: 0 };
      hpMax = Number(props.hp ?? bossDefaults.hp); atk = Number(props.atk ?? props.attack ?? 10);
      def = Number(props.def ?? props.defense ?? bossDefaults.def); initiative = Number(props.initiative ?? bossDefaults.initiative);
      profile = { stats: { attack: atk, defense: def, initiative }, equipmentRarityScore: 0 };
    }
    const abilityClass = playerClass ? toAbilityClass(playerClass) : undefined;
    if (c.modeMultiplier !== 1) {
      hpMax = Math.floor(hpMax * c.modeMultiplier + .5);
      profile.stats.damageDealtPercent = (profile.stats.damageDealtPercent ?? 0) + c.modeMultiplier - 1;
      profile.stats.healingPercent = (profile.stats.healingPercent ?? 0) + c.modeMultiplier - 1;
    }
    const abilityDefinitions = playerClass ? abilitiesForClass(playerClass) : [];
    return {
      id: c.id, entityType: c.entityType as "PLAYER" | "ENEMY", entityId: c.entityId,
      teamId: c.teamId ?? undefined, hpCurrent: Math.min(c.hpCurrent, hpMax), hpMax,
      atk, def, initiative, attack: atk, defense: def, initiativeTieBreaker: 0,
      stats: profile.stats, equipmentRarityScore: profile.equipmentRarityScore,
      name, isDowned: c.hpCurrent <= 0, shield: Math.min(hpMax * .5,
        effectsData.filter((e) => e.targetId === c.id).reduce((sum, e) => sum + (e.shieldRemaining ?? 0), 0) +
        combatEffectsData.filter((e) => e.targetCombatantId === c.id).reduce((sum, e) => sum + (typeof e.state.shield === "number" ? e.state.shield : 0), 0)),
      ...(c.lastTargetId ? { lastTargetId: c.lastTargetId } : {}), modeMultiplier: c.modeMultiplier,
      statusEffects: combatEffectsData.filter((effect) => effect.targetCombatantId === c.id &&
        (effect.expiresAtRound == null || effect.expiresAtRound >= combat.roundNumber)).map((effect) => {
          const definition = ABILITY_DEFINITIONS[effect.abilityId as AbilityId];
          return { id: effect.id, name: definition?.displayName ?? effect.abilityId,
            icon: definition?.effect.kind === "CLEANSE_AND_SHIELD" ? "🛡️" : "✨",
            color: definition?.effect.kind === "DAMAGE_AND_DEFENSE_REDUCTION" || definition?.effect.kind === "NEXT_ACTION_DAMAGE_REDUCTION" ? "#f87171" : "#fbbf24",
            description: definition?.description ?? effect.abilityId,
            remainingRounds: effect.expiresAtRound == null ? 0 : Math.max(0, effect.expiresAtRound - combat.roundNumber + 1) };
        }), ...(playerClass ? { class: playerClass } : {}), abilityDefinitions, abilities: abilityDefinitions,
      abilityCooldowns: Object.fromEntries(abilityCooldownData.filter((row) => row.combatantId === c.id)
        .map((row) => [row.abilityId, Math.max(0, row.availableAtRound - combat.roundNumber)])),
      ...(enemyBehavior ? { enemyBehavior } : {}),
    };
  }));

  return {
    id: combat.id,
    type: combat.type as "PVE" | "PVP" | "BOSS",
    state: combat.state as CombatInstance["state"],
    roundNumber: combat.roundNumber,
    startedAt: combat.startedAt,
    combatants: enrichedCombatants,
    actions: actionsData.map((a) => ({
      id: a.id,
      roundNumber: a.roundNumber,
      actorId: a.actorId,
      actionType: a.actionType as ActionType,
      abilityId: a.abilityId as AbilityId | undefined,
      targetId: a.targetId ?? undefined,
      isLocked: a.isLocked,
      origin: a.origin,
    })),
    threat: threatData.map((entry) => ({ enemyCombatantId: entry.enemyCombatantId,
      playerCombatantId: entry.playerCombatantId, amount: entry.amount })),
    ...(combat.actionDeadline ? { actionDeadline: combat.actionDeadline } : {}),
  };
}

function toAbilityClass(playerClass: string) {
  return CLASS_ABILITY_CLASSES[playerClass as ClassId];
}

/**
 * Submit a combat action for a player.
 */
export async function submitCombatAction(opts: {
  combatId: string;
  playerId: string;
  roundNumber: number;
  actionType: ActionType;
  abilityId?: AbilityId | undefined;
  targetId?: string | undefined;
  idempotencyKey: string;
  wsHub?: WsHub;
}): Promise<CombatAction> {
  const { combatId, playerId, roundNumber, actionType, abilityId, targetId, idempotencyKey, wsHub } = opts;
  const validationSnapshot = await getCombatInstance(combatId);

  const submitted = await db.transaction(async (tx) => {
    // Serialize submission and lock. This makes the last transaction accepted
    // before LOCKED the authoritative action for the round.
    await tx.execute(sql`select id from combat_instance where id = ${combatId} for update`);

    const [receipt] = await tx.select().from(combatActionSubmissions)
      .where(eq(combatActionSubmissions.idempotencyKey, idempotencyKey));
    if (receipt) {
      return {
        id: receipt.actionId, roundNumber: receipt.roundNumber, actorId: receipt.actorId,
        actionType: receipt.actionType as ActionType,
        abilityId: receipt.abilityId as AbilityId | undefined,
        targetId: receipt.targetId ?? undefined, isLocked: false,
        origin: "PLAYER_SUBMITTED" as const,
      };
    }

    const [combat] = await tx.select().from(combatInstances)
      .where(eq(combatInstances.id, combatId));
    if (!combat || combat.state !== "AWAITING_ACTIONS" || combat.roundNumber !== roundNumber ||
      !combat.actionDeadline || combat.actionDeadline.getTime() <= Date.now()) {
      throw new Error("Combat is not accepting actions");
    }
    const [actor] = await tx.select().from(combatants).where(and(
      eq(combatants.combatInstanceId, combatId),
      eq(combatants.entityId, playerId),
      eq(combatants.entityType, "PLAYER")
    ));
    if (!actor) throw new Error("Player not in combat");
    if (actor.hpCurrent <= 0) throw new Error("Player is downed");

    if (abilityId) {
      const definition = ABILITY_DEFINITIONS[abilityId];
      const [player] = await tx.select({ class: players.class }).from(players).where(eq(players.id, playerId));
      const abilityClass = player?.class ? toAbilityClass(player.class) : undefined;
      if (!abilityClass || !CLASS_LOADOUTS[abilityClass].includes(abilityId)) throw new Error("Ability is not in fighter loadout");
      if (definition.passive) throw new Error("Passive abilities cannot be submitted");
      const [cooldown] = await tx.select().from(combatAbilityCooldowns).where(and(
        eq(combatAbilityCooldowns.combatantId, actor.id), eq(combatAbilityCooldowns.abilityId, abilityId)));
      if (cooldown && cooldown.availableAtRound > combat.roundNumber) throw new Error("Ability is on cooldown");
      const target = targetId ? (await tx.select().from(combatants).where(and(
        eq(combatants.id, targetId), eq(combatants.combatInstanceId, combatId))))[0] : undefined;
      validateAbilityTarget(definition, actor, target, validationSnapshot.type);
      if (definition.conditions.some((condition) => condition.kind === "TARGET_HP_AT_MOST_PERCENT" &&
        (!target || target.hpCurrent / Math.max(1, validationSnapshot.combatants.find((c) => c.id === target.id)?.hpMax ?? 1) * 100 > condition.percent))) throw new Error("Ability condition is not met");
    }

    if (actionType === "ATTACK") {
      if (!targetId) throw new Error("Attack requires a target");
      const [target] = await tx.select().from(combatants).where(and(
        eq(combatants.id, targetId), eq(combatants.combatInstanceId, combatId)
      ));
      if (!target || target.hpCurrent <= 0 || !areOpponents(actor, target, validationSnapshot.type)) {
        throw new Error("Invalid attack target");
      }
    }

    const [action] = await tx.insert(combatActions).values({
      combatInstanceId: combatId, roundNumber: combat.roundNumber, actorId: actor.id,
      actionType, abilityId: abilityId ?? null, targetId: targetId ?? null, isLocked: false,
      origin: "PLAYER_SUBMITTED", idempotencyKey,
    }).onConflictDoUpdate({
      target: [combatActions.combatInstanceId, combatActions.roundNumber, combatActions.actorId],
      set: { actionType, abilityId: abilityId ?? null, targetId: targetId ?? null, idempotencyKey, origin: "PLAYER_SUBMITTED" },
      setWhere: eq(combatActions.isLocked, false),
    }).returning();
    if (!action) throw new Error("Combat action is locked");
    await tx.execute(sql`DELETE FROM combat_item_action WHERE combat_action_id=${action.id}::uuid`);

    await tx.insert(combatActionSubmissions).values({
      idempotencyKey, actionId: action.id, combatInstanceId: combatId,
      roundNumber: action.roundNumber, actorId: actor.id, actionType,
      targetId: targetId ?? null, abilityId: abilityId ?? null,
    });
    const response = { id: action.id, roundNumber: action.roundNumber, actorId: action.actorId,
      actionType: action.actionType as ActionType, abilityId: action.abilityId as AbilityId | undefined, targetId: action.targetId ?? undefined,
      isLocked: action.isLocked, origin: action.origin };
    return response;
  });
  const [combat] = await db.select().from(combatInstances).where(eq(combatInstances.id, combatId));
  if (combat?.state === "AWAITING_ACTIONS") {
    const pending = await db.execute<{ missing: string }>(sql`
      SELECT COUNT(*)::text missing FROM combatant c
      WHERE c.combat_instance_id=${combatId}::uuid AND c.entity_type='PLAYER' AND c.hp_current>0
        AND NOT EXISTS (SELECT 1 FROM combat_action a WHERE a.combat_instance_id=c.combat_instance_id
          AND a.round_number=${combat.roundNumber} AND a.actor_id=c.id)`);
    if (Number(pending.rows[0]?.missing ?? 1) === 0) {
      setTimeout(() => void lockAndResolveRound(combatId, wsHub).catch(() => undefined), 0);
    }
  }
  return submitted;
}

function validateAbilityTarget(definition: AbilityDefinition, actor: typeof combatants.$inferSelect,
  target: typeof combatants.$inferSelect | undefined, combatType: CombatInstance["type"]) {
  if (definition.allowedTargetTypes.includes("ALL_ACTIVE_ALLIES")) {
    if (target) throw new Error("Ability does not accept a target");
    return;
  }
  if (!target) throw new Error("Ability requires a target");
  const ownTeam = actor.teamId === target.teamId;
  const valid = (definition.allowedTargetTypes.includes("SELF") && actor.id === target.id) ||
    (definition.allowedTargetTypes.includes("ALLY") && ownTeam && actor.id !== target.id) ||
    (definition.allowedTargetTypes.includes("ENEMY") && areOpponents(actor, target, combatType));
  if (!valid || target.hpCurrent <= 0) throw new Error("Invalid ability target");
}

function areOpponents(a: typeof combatants.$inferSelect, b: typeof combatants.$inferSelect,
  combatType?: CombatInstance["type"]) {
  if (combatType === "BOSS") return a.entityType !== b.entityType;
  if (a.teamId && b.teamId) return a.teamId !== b.teamId;
  return a.entityType !== b.entityType;
}

/**
 * Schedule auto-lock of round after timer expires.
 */
function scheduleRoundLock(combatId: string, delayMs: number, wsHub?: WsHub) {
  setTimeout(async () => {
    try {
      await lockAndResolveRound(combatId, wsHub);
    } catch (err) {
      console.error(`Failed to auto-lock round for combat ${combatId}:`, err);
    }
  }, delayMs);
}

/**
 * Lock actions and resolve the current round.
 */
export async function lockAndResolveRound(
  combatId: string,
  wsHub?: WsHub
): Promise<CombatLog[]> {
  // Re-read current stats/equipment at the start of every round.
  const combatSnapshot = await getCombatInstance(combatId);
  const snapshotByActor = new Map(combatSnapshot.combatants.map((actor) => [actor.id, actor]));
  const roundNumber = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from combat_instance where id = ${combatId} for update`);
    const [combat] = await tx.select().from(combatInstances).where(eq(combatInstances.id, combatId));
    if (!combat || combat.state !== "AWAITING_ACTIONS") throw new Error("Combat round already locked");

    const participants = await tx.select().from(combatants)
      .where(eq(combatants.combatInstanceId, combatId));
    const threatEntries = await tx.select().from(combatThreat)
      .where(eq(combatThreat.combatInstanceId, combatId));
    const alive = participants.filter((c) => c.hpCurrent > 0);
    for (const actor of alive) {
      const targets = alive.filter((target) => areOpponents(actor, target, combat.type as CombatInstance["type"]))
        .sort((a, b) => a.id.localeCompare(b.id));
      const snapshot = snapshotByActor.get(actor.id);
      const target = actor.entityType === "ENEMY"
        ? selectEnemyAiTarget(snapshot, targets, threatEntries, snapshotByActor)
        : targets.find((candidate) => candidate.id === actor.lastTargetId) ?? targets[0];
      if (!target) continue;
      await tx.insert(combatActions).values({
        combatInstanceId: combatId, roundNumber: combat.roundNumber, actorId: actor.id,
        actionType: "ATTACK", targetId: target.id, isLocked: true,
        origin: actor.entityType === "PLAYER" ? "AUTOMATIC" : "ENEMY_AI",
        idempotencyKey: randomUUID(),
      }).onConflictDoNothing({
        target: [combatActions.combatInstanceId, combatActions.roundNumber, combatActions.actorId],
      });
    }
    await tx.update(combatActions).set({ isLocked: true }).where(and(
      eq(combatActions.combatInstanceId, combatId),
      eq(combatActions.roundNumber, combat.roundNumber)
    ));
    await tx.update(combatInstances).set({ state: "LOCKED" })
      .where(eq(combatInstances.id, combatId));

    // Snapshot all ordering inputs once per round. The random value is generated
    // server-side only and survives retries/restarts through this table.
    for (const actor of alive) {
      const snapshot = snapshotByActor.get(actor.id);
      if (!snapshot) throw new Error(`Missing stat snapshot for combatant ${actor.id}`);
      const stats = snapshot.stats ?? { attack: snapshot.atk, defense: snapshot.def, initiative: snapshot.initiative };
      await tx.insert(combatRoundOrders).values({
        combatInstanceId: combatId,
        roundNumber: combat.roundNumber,
        actorId: actor.id,
        effectiveInitiative: Math.round(calculateEffectiveInitiative(stats)),
        equipmentRarityScore: snapshot?.equipmentRarityScore ?? 0,
        roundRandom: randomInt(0, 2_147_483_647),
      }).onConflictDoNothing({
        target: [combatRoundOrders.combatInstanceId, combatRoundOrders.roundNumber, combatRoundOrders.actorId],
      });
    }
    return combat.roundNumber;
  });

  // Resolve round
  await db.update(combatInstances).set({ state: "RESOLVING" }).where(and(
    eq(combatInstances.id, combatId), eq(combatInstances.state, "LOCKED")));
  const logs = await resolveRound(combatId, wsHub);

  // Round resolution is the common opposing-phase boundary for PvE, PvP and
  // bosses. Expiring here means initiative can never truncate the full phase.
  await expireOpponentPhaseEffects(combatId, roundNumber);

  // Check for combat end
  const updatedCombat = await getCombatInstance(combatId);
  const isComplete = checkCombatComplete(updatedCombat);

  if (isComplete) {
    const aliveTeams = [...new Set(updatedCombat.combatants.filter((c) => c.entityType === "PLAYER" && !c.isDowned)
      .flatMap((c) => c.teamId ? [c.teamId] : []))];
    const bossDefeated = updatedCombat.type === "BOSS" && updatedCombat.combatants
      .filter((c) => c.entityType === "ENEMY").every((c) => c.isDowned);
    const winnerTeamId = updatedCombat.type !== "BOSS" && aliveTeams.length === 1 ? aliveTeams[0] : undefined;
    await db.update(combatInstances).set({ state: "COMPLETED", completedAt: new Date(),
      outcome: winnerTeamId || bossDefeated ? "VICTORY" : "DEFEAT", winnerTeamId: winnerTeamId ?? null,
      resolutionVersion: sql`${combatInstances.resolutionVersion} + 1` }).where(and(
        eq(combatInstances.id, combatId), sql`${combatInstances.completedAt} IS NULL`));
    const completedTeamIds = [...new Set(updatedCombat.combatants.flatMap((c) => c.teamId ? [c.teamId] : []))];
    await Promise.all(completedTeamIds.map((teamId) => markTeamRegenStopped(teamId)));

    // Ordinary combat effects must not leak into subsequent encounters.
    await db.delete(statusEffectInstances).where(and(
      eq(statusEffectInstances.combatInstanceId, combatId),
      sql`${statusEffectInstances.effectId} in (
        select id from ${statusEffectDefinitions}
        where ${statusEffectDefinitions.persistenceScope} = 'COMBAT'
      )`,
    ));

    const completedCombat = await getCombatInstance(combatId);

    const defeatedTeams = completedTeamIds.filter((teamId) => completedCombat.combatants
      .filter((c) => c.teamId === teamId && c.entityType === "PLAYER").every((c) => c.isDowned));
    await Promise.all(defeatedTeams.map((teamId) => handleTeamWipe({ teamId, combatId, ...(wsHub ? { wsHub } : {}) })));
    if (completedCombat.type === "PVP" && winnerTeamId) {
      await awardPvPFame(combatId, winnerTeamId, defeatedTeams[0]);
      if (defeatedTeams[0]) await transferPvPLoot(combatId, winnerTeamId, defeatedTeams[0]);
      await Promise.all(defeatedTeams.map((teamId) => grantPvPProtection(teamId)));
    }
    if (completedCombat.type === "PVE" && winnerTeamId) {
      await resolvePvEQuestVictory(completedCombat, winnerTeamId, wsHub);
    }
    if (completedCombat.type === "BOSS" && bossDefeated) await finalizeBossRewards(completedCombat);

    if (wsHub) for (const teamId of completedTeamIds) {
      wsHub.sendToTeam(teamId, {
        event: "combat:completed",
        data: { combatId, logs, combatants: completedCombat.combatants },
      });
    }
  } else {
    // Start next round
    await applyPendingRevives(combatId, roundNumber + 1);
    await db
      .update(combatInstances)
      .set({
        state: "AWAITING_ACTIONS",
        roundNumber: roundNumber + 1,
        ...newRoundTiming(),
      })
      .where(eq(combatInstances.id, combatId));

    scheduleRoundLock(combatId, ROUND_TIMER_MS, wsHub);

    if (wsHub) for (const teamId of [...new Set(updatedCombat.combatants.flatMap((c) => c.teamId ? [c.teamId] : []))]) {
      wsHub.sendToTeam(teamId, {
        event: "combat:round_resolved",
        data: {
          combatId,
          round: roundNumber + 1,
          logs,
          combatants: (await getCombatInstance(combatId)).combatants,
        },
      });
    }
  }

  return logs;
}

export async function submitCombatRevive(opts: { combatId: string; playerId: string; targetId: string;
  itemInstanceId: string; requestId: string }): Promise<{ effectiveRound: number; hpPercent: number }> {
  return db.transaction(async (tx) => {
    const replay = await tx.execute<{ effective_round: number; hp_percent: number }>(sql`
      SELECT effective_round,hp_percent FROM combat_revive_request WHERE request_id=${opts.requestId}::uuid`);
    if (replay.rows[0]) return { effectiveRound: replay.rows[0].effective_round, hpPercent: replay.rows[0].hp_percent };
    const [combat] = await tx.select().from(combatInstances).where(eq(combatInstances.id, opts.combatId));
    if (!combat || !["AWAITING_ACTIONS", "LOCKED", "RESOLVING"].includes(combat.state)) throw new Error("Combat is not active");
    const [actor] = await tx.select().from(combatants).where(and(eq(combatants.combatInstanceId, opts.combatId),
      eq(combatants.entityId, opts.playerId), eq(combatants.entityType, "PLAYER")));
    const [target] = await tx.select().from(combatants).where(and(eq(combatants.id, opts.targetId),
      eq(combatants.combatInstanceId, opts.combatId)));
    if (!actor || actor.hpCurrent <= 0 || !target || target.entityType !== "PLAYER" || target.teamId !== actor.teamId || target.hpCurrent > 0) {
      throw new Error("Invalid revive actor or target");
    }
    const [player] = await tx.select({ class: players.class }).from(players).where(eq(players.id, opts.playerId));
    const hpPercent = player?.class === "cleric" ? 50 : 30;
    const consumed = await tx.execute(sql`UPDATE item_instance i SET quantity=quantity-1
      FROM item_def d WHERE i.id=${opts.itemInstanceId}::uuid AND i.definition_id=d.key
        AND i.owner_type='PLAYER' AND i.owner_id=${opts.playerId}::uuid AND i.quantity>0
        AND i.category='CONSUMABLE' AND d.key='balm_returning' RETURNING i.id,i.quantity`);
    if (!consumed.rows.length) throw new Error("Balsam der Wiederkehr is unavailable");
    await tx.execute(sql`DELETE FROM item_instance WHERE id=${opts.itemInstanceId}::uuid AND quantity=0`);
    const effectiveRound = combat.roundNumber + 1;
    await tx.execute(sql`INSERT INTO combat_revive_request
      (request_id,combat_id,actor_id,target_id,item_instance_id,effective_round,hp_percent)
      VALUES (${opts.requestId}::uuid,${opts.combatId}::uuid,${actor.id}::uuid,${target.id}::uuid,
        ${opts.itemInstanceId}::uuid,${effectiveRound},${hpPercent})`);
    return { effectiveRound, hpPercent };
  });
}

async function applyPendingRevives(combatId: string, roundNumber: number): Promise<void> {
  const pending = await db.execute<{ request_id: string; actor_id: string; target_id: string; hp_percent: number; entity_id: string; mode_multiplier: number }>(sql`
    SELECT r.request_id,r.actor_id,r.target_id,r.hp_percent,c.entity_id,c.mode_multiplier FROM combat_revive_request r
    JOIN combatant c ON c.id=r.target_id WHERE r.combat_id=${combatId}::uuid
      AND r.effective_round<=${roundNumber} AND r.applied_at IS NULL FOR UPDATE`);
  for (const revive of pending.rows) {
    const [player] = await db.select().from(players).where(eq(players.id, revive.entity_id));
    if (!player?.class) continue;
    const playerHp = Math.floor((await getPlayerStats(player)).hpMax * revive.hp_percent / 100 + .5);
    const hp = Math.floor(playerHp * revive.mode_multiplier + .5);
    await db.transaction(async (tx) => {
      const applied = await tx.execute(sql`UPDATE combat_revive_request SET applied_at=now()
        WHERE request_id=${revive.request_id}::uuid AND applied_at IS NULL RETURNING request_id`);
      if (!applied.rows.length) return;
      await tx.update(combatants).set({ hpCurrent: hp }).where(eq(combatants.id, revive.target_id));
      await tx.update(players).set({ hpCurrent: playerHp, status: "ACTIVE" }).where(eq(players.id, revive.entity_id));
    });
    const combat = await getCombatInstance(combatId);
    const actor = combat.combatants.find((candidate) => candidate.id === revive.actor_id);
    if (actor) await recordBossContribution(combat, actor, "REVIVE", 30, "balm_returning");
  }
}

/** Re-arms persisted round deadlines after a process restart. */
export async function recoverCombatTimers(wsHub?: WsHub): Promise<void> {
  // Re-schedule AWAITING_ACTIONS combats (deadline may be in the past or future)
  const awaiting = await db.select().from(combatInstances).where(eq(combatInstances.state, "AWAITING_ACTIONS"));
  for (const combat of awaiting) {
    const delay = Math.max(0, (combat.actionDeadline?.getTime() ?? Date.now()) - Date.now());
    scheduleRoundLock(combat.id, delay, wsHub);
    console.log(`[combat] Recovered AWAITING_ACTIONS combat ${combat.id}, resolving in ${delay}ms`);
  }

  // Force-resolve combats stuck in LOCKED or RESOLVING (e.g. server crashed mid-resolution)
  const stuck = await db.select().from(combatInstances).where(
    sql`${combatInstances.state} IN ('LOCKED', 'RESOLVING') AND ${combatInstances.completedAt} IS NULL`
  );
  for (const combat of stuck) {
    console.log(`[combat] Force-resolving stuck combat ${combat.id} (state=${combat.state})`);
    // NOTE: these are already past the lock phase, so call resolveRound branch directly
    // by resetting state to LOCKED first (lockAndResolveRound checks for AWAITING_ACTIONS).
    setTimeout(async () => {
      try {
        // Reset to LOCKED so lockAndResolveRound can take over from the resolve phase
        await db.update(combatInstances)
          .set({ state: "LOCKED" })
          .where(eq(combatInstances.id, combat.id));
        // Now call the full path but it will skip the AWAITING_ACTIONS guard since
        // resolveRound is called after the LOCKED→RESOLVING transition
        const logs = await resolveRound(combat.id, wsHub);
        // Complete or start next round (mirrors the post-resolve logic in lockAndResolveRound)
        const updatedCombat = await getCombatInstance(combat.id);
        const isComplete = checkCombatComplete(updatedCombat);
        if (!isComplete) {
          const roundNumber = updatedCombat.roundNumber;
          await expireOpponentPhaseEffects(combat.id, roundNumber);
          await applyPendingRevives(combat.id, roundNumber + 1);
          await db.update(combatInstances).set({
            state: "AWAITING_ACTIONS",
            roundNumber: roundNumber + 1,
            ...newRoundTiming(),
          }).where(eq(combatInstances.id, combat.id));
          scheduleRoundLock(combat.id, ROUND_TIMER_MS, wsHub);
          if (wsHub) {
            const teamIds = [...new Set(updatedCombat.combatants.flatMap((c) => c.teamId ? [c.teamId] : []))];
            for (const teamId of teamIds) {
              wsHub.sendToTeam(teamId, {
                event: "combat:round_resolved",
                data: { combatId: combat.id, round: roundNumber + 1, logs, combatants: (await getCombatInstance(combat.id)).combatants },
              });
            }
          }
        }
      } catch (err) {
        console.error(`[combat] Recovery resolution failed for ${combat.id}:`, err);
      }
    }, 2_000);
  }

  const warnings = await db.select().from(pvpChallenges).where(eq(pvpChallenges.state, "WARNING"));
  for (const warning of warnings) schedulePvPEscalation(warning.id,
    Math.max(0, warning.expiresAt.getTime() - Date.now()), wsHub);
}

/**
 * Resolve all actions in the current round.
 */
async function resolveRound(combatId: string, wsHub?: WsHub): Promise<CombatLog[]> {
  const combat = await getCombatInstance(combatId);
  const logs: CombatLog[] = [];

  // Get actions for current round
  const roundActions = combat.actions.filter(
    (a) => a.roundNumber === combat.roundNumber
  );

  const roundOrder = await db.select().from(combatRoundOrders).where(and(
    eq(combatRoundOrders.combatInstanceId, combatId),
    eq(combatRoundOrders.roundNumber, combat.roundNumber),
  ));
  const orderByActor = new Map(roundOrder.map((entry) => [entry.actorId, entry]));

  // Sort by initiative (higher goes first)
  const sortedActions = roundActions.sort((a, b) => {
    const actorA = orderByActor.get(a.actorId);
    const actorB = orderByActor.get(b.actorId);
    if (!actorA || !actorB) throw new Error("Incomplete persisted round order");
    return compareRoundOrder(actorA, actorB);
  });

  // Execute actions in initiative order
  for (const action of sortedActions) {
    const actor = combat.combatants.find((c) => c.id === action.actorId);
    if (!actor || actor.isDowned) continue;
    await db.delete(combatEffects).where(and(eq(combatEffects.combatInstanceId, combat.id),
      eq(combatEffects.sourceCombatantId, actor.id),
      sql`${combatEffects.abilityId} IN ('gardist.leibwache','condottiere.duell')`,
      sql`${combatEffects.expiresAtRound} < ${combat.roundNumber}`));

    if (action.abilityId) {
      await resolveAbility(combat, actor, action.abilityId, action.targetId, logs);
    } else if (action.actionType === "DEFEND") {
      const item=await resolveCombatConsumable(action.id,combat.id,combat.roundNumber);
      if(item) logs.push({timestamp:new Date(),message:`${actor.name} verwendet ${item}.`,type:"EFFECT"});
    } else if (action.actionType === "ATTACK" && action.targetId) {
      let targetMaybe = combat.combatants.find((c) => c.id === action.targetId);
      if (!targetMaybe || targetMaybe.isDowned) targetMaybe = defaultEnemyTarget(combat, actor);
      if (!targetMaybe) continue;
      
      // Calculate damage
      const powerEvery = actor.enemyBehavior?.powerAttackEvery ?? 0;
      const isPowerAttack = actor.entityType === "ENEMY" && powerEvery > 0 && combat.roundNumber % powerEvery === 0;
      const attackMultiplier = isPowerAttack ? actor.enemyBehavior?.powerAttackMultiplier ?? 1.35 : 1;
      let damage = await calculateActionDamage(combat, actor, targetMaybe, attackMultiplier);
      const whetstone=(await db.select().from(combatEffects).where(and(eq(combatEffects.combatInstanceId,combat.id),
        eq(combatEffects.sourceCombatantId,actor.id),eq(combatEffects.abilityId,"item.wetzstein_legionaer"))))[0];
      if(whetstone){damage=Math.round(damage*1.5);await db.delete(combatEffects).where(eq(combatEffects.id,whetstone.id));}

      // Apply damage
      const dealt = await applyAbilityModifiers(combat, actor, targetMaybe, damage);
      await addDamageThreat(combat, actor, targetMaybe, dealt);
      const newHp = targetMaybe.hpCurrent;
      await db.update(combatants).set({ lastTargetId: targetMaybe.id }).where(eq(combatants.id, actor.id));

      logs.push({
        timestamp: new Date(),
        message: isPowerAttack
          ? `${actor.name} setzt ${actor.enemyBehavior?.type ?? "Spezialangriff"} gegen ${targetMaybe.name} ein: ${dealt} Schaden!`
          : `${actor.name} attacks ${targetMaybe.name} for ${dealt} damage!`,
        type: "DAMAGE",
      });

      if (newHp <= 0) {
        logs.push({
          timestamp: new Date(),
          message: `${targetMaybe.name} is downed!`,
          type: "STATE",
        });

      }

      // Update combatant in memory
      targetMaybe.isDowned = newHp <= 0;
    }
  }

  return logs;
}

function selectEnemyAiTarget(
  actor: Combatant | undefined,
  candidates: Array<typeof combatants.$inferSelect>,
  threatEntries: Array<typeof combatThreat.$inferSelect>,
  snapshots: Map<string, Combatant>,
): typeof combatants.$inferSelect | undefined {
  if (!actor) return candidates[0];
  const strategy = actor.enemyBehavior?.targetStrategy ?? "THREAT";
  const enriched = candidates.map((candidate) => ({
    candidate,
    snapshot: snapshots.get(candidate.id),
    threat: threatEntries.find((entry) => entry.enemyCombatantId === actor.id &&
      entry.playerCombatantId === candidate.id)?.amount ?? 0,
  }));
  if (strategy === "LOWEST_HP") {
    return enriched.sort((a, b) => a.candidate.hpCurrent - b.candidate.hpCurrent ||
      a.candidate.id.localeCompare(b.candidate.id))[0]?.candidate;
  }
  if (strategy === "HIGHEST_ATTACK" || strategy === "LOWEST_DEFENSE") {
    return enriched.sort((a, b) => strategy === "HIGHEST_ATTACK"
      ? (b.snapshot?.atk ?? 0) - (a.snapshot?.atk ?? 0) || a.candidate.id.localeCompare(b.candidate.id)
      : (a.snapshot?.def ?? 0) - (b.snapshot?.def ?? 0) || a.candidate.id.localeCompare(b.candidate.id))[0]?.candidate;
  }
  return selectThreatTarget(enriched.map(({ candidate, threat }) => ({ ...candidate, threat })));
}

function defaultEnemyTarget(combat: CombatInstance, actor: Combatant): Combatant | undefined {
  const candidates = combat.combatants.filter((candidate) => !candidate.isDowned && candidate.id !== actor.id &&
    (combat.type === "BOSS" ? actor.entityType !== candidate.entityType :
      ((actor.teamId && candidate.teamId) ? actor.teamId !== candidate.teamId : actor.entityType !== candidate.entityType)));
  if (actor.entityType === "ENEMY") return selectThreatTarget(candidates.map((candidate) => ({
    ...candidate,
    threat: combat.threat.find((entry) => entry.enemyCombatantId === actor.id &&
      entry.playerCombatantId === candidate.id)?.amount ?? 0,
  })));
  return candidates.find((candidate) => candidate.id === actor.lastTargetId) ?? candidates[0];
}

async function resolveAbility(combat: CombatInstance, actor: Combatant, abilityId: AbilityId,
  targetId: string | undefined, logs: CombatLog[]) {
  const definition = ABILITY_DEFINITIONS[abilityId];
  const target = targetId ? combat.combatants.find((candidate) => candidate.id === targetId) : undefined;
  const effect = definition.effect;
  if (definition.cooldownRounds > 0) {
    await db.insert(combatAbilityCooldowns).values({ combatInstanceId: combat.id, combatantId: actor.id,
      abilityId, availableAtRound: combat.roundNumber + definition.cooldownRounds + 1 }).onConflictDoUpdate({
      target: [combatAbilityCooldowns.combatantId, combatAbilityCooldowns.abilityId],
      set: { availableAtRound: combat.roundNumber + definition.cooldownRounds + 1 },
    });
  }
  if ((effect.kind === "DAMAGE" || effect.kind === "DAMAGE_AND_DEFENSE_REDUCTION") && target) {
    const condition = definition.conditions.find((item) => item.kind === "TARGET_HP_AT_MOST_PERCENT");
    if (condition?.kind === "TARGET_HP_AT_MOST_PERCENT" && target.hpCurrent / target.hpMax * 100 > condition.percent) {
      logs.push({ timestamp: new Date(), message: `${definition.displayName} scheitert: HP-Bedingung nicht erfüllt.`, type: "EFFECT" });
      return;
    }
    const damage = await calculateActionDamage(combat, actor, target, effect.attackMultiplier);
    const dealt = await applyAbilityModifiers(combat, actor, target, damage);
    await addDamageThreat(combat, actor, target, dealt,
      effect.kind === "DAMAGE" && "threatBonusPercent" in effect ? effect.threatBonusPercent ?? 0 : 0);
    logs.push({ timestamp: new Date(), message: `${actor.name} wirkt ${definition.displayName} auf ${target.name}: ${dealt} Schaden.`, type: "DAMAGE" });
    if (effect.kind === "DAMAGE_AND_DEFENSE_REDUCTION") await addEffect(combat, actor, target, abilityId,
      combat.roundNumber + 1,{armorBreakPercentPoints:actor.stats?.armorBreakPercentPoints??0});
    if (effect.kind === "DAMAGE" && "selfIncomingDamagePercent" in effect && effect.selfIncomingDamagePercent) await addEffect(combat, actor, actor, abilityId, combat.roundNumber);
  } else if (effect.kind === "HEAL" && target) {
    const attack = actor.stats?.attack ?? actor.atk;
    const amount = calculateHealing(effect.flat + effect.attackMultiplier * attack,
      actor.stats?.healingPercent ?? 0, target.hpCurrent, target.hpMax);
    target.hpCurrent += amount;
    await db.update(combatants).set({ hpCurrent: target.hpCurrent }).where(eq(combatants.id, target.id));
    if (target.entityType === "PLAYER") await db.update(players).set({
      hpCurrent: Math.floor(target.hpCurrent / (target.modeMultiplier ?? 1) + .5), status: "ACTIVE",
    }).where(eq(players.id, target.entityId));
    await recordBossContribution(combat, actor, "HEALING", amount * .8, abilityId);
    logs.push({ timestamp: new Date(), message: `${definition.displayName} heilt ${target.name} um ${amount}.`, type: "EFFECT" });
  } else if (effect.kind === "BODYGUARD" && target) {
    await addEffect(combat, actor, target, abilityId, combat.roundNumber);
  } else if (effect.kind === "TEAM_DAMAGE_REDUCTION") {
    const lifetime = nextCompleteOpponentPhase(combat.roundNumber);
    for (const ally of combat.combatants.filter((item) => item.teamId === actor.teamId && !item.isDowned)) {
      await addEffect(combat, actor, ally, abilityId, undefined, { ...lifetime });
    }
  } else if (effect.kind === "NEXT_ACTION_DAMAGE_REDUCTION" && target) {
    await addEffect(combat, actor, target, abilityId, undefined, { nextAction: true });
  } else if (effect.kind === "CLEANSE_AND_SHIELD" && target) {
    const negative = await db.select().from(combatEffects).where(and(eq(combatEffects.targetCombatantId, target.id), sql`${combatEffects.abilityId} IN ('sculptor.schwachstelle','sculptor.marmorstaub','condottiere.duell')`));
    const priority: Record<string, number> = {
      "condottiere.duell": 1, "sculptor.marmorstaub": 2, "sculptor.schwachstelle": 3,
    };
    const first = negative.sort((a, b) => (priority[a.abilityId] ?? 99) - (priority[b.abilityId] ?? 99) ||
      a.id.localeCompare(b.id))[0];
    if (first) await db.delete(combatEffects).where(eq(combatEffects.id, first.id));
    await addEffect(combat, actor, target, abilityId, undefined, { shield: effect.shield });
  }
  logs.push({ timestamp: new Date(), message: `${actor.name} verwendet ${definition.displayName}.`, type: "ACTION" });
}

async function addDamageThreat(combat: CombatInstance, actor: Combatant, target: Combatant,
  damageDealt: number, bonusPercent = 0): Promise<void> {
  if (actor.entityType !== "PLAYER" || target.entityType !== "ENEMY") return;
  const amount = calculateGeneratedThreat(damageDealt, bonusPercent);
  if (amount === 0) return;
  await db.insert(combatThreat).values({ combatInstanceId: combat.id, enemyCombatantId: target.id,
    playerCombatantId: actor.id, amount }).onConflictDoUpdate({
      target: [combatThreat.enemyCombatantId, combatThreat.playerCombatantId],
      set: { amount: sql`${combatThreat.amount} + ${amount}` },
    });
  const existing = combat.threat.find((entry) => entry.enemyCombatantId === target.id &&
    entry.playerCombatantId === actor.id);
  if (existing) existing.amount += amount;
  else combat.threat.push({ enemyCombatantId: target.id, playerCombatantId: actor.id, amount });
}

async function calculateActionDamage(combat: CombatInstance, actor: Combatant, target: Combatant,
  multiplier: number): Promise<number> {
  const effects = await db.select().from(combatEffects).where(eq(combatEffects.combatInstanceId, combat.id));
  const weakness = effects.find((effect) => effect.targetCombatantId === target.id &&
    effect.abilityId === "sculptor.schwachstelle" && (effect.expiresAtRound == null || effect.expiresAtRound >= combat.roundNumber));
  const attacker = { ...(actor.stats ?? { attack: actor.atk, defense: actor.def, initiative: actor.initiative }) };
  const defender = { ...(target.stats ?? { attack: target.atk, defense: target.def, initiative: target.initiative }) };
  const dust = effects.find((effect) => effect.targetCombatantId === actor.id &&
    effect.abilityId === "sculptor.marmorstaub" && (effect.expiresAtRound == null || effect.expiresAtRound >= combat.roundNumber));
  attacker.damageDealtPercent = (attacker.damageDealtPercent ?? 0) + (dust ? -.35 : 0) +
    (actor.abilityDefinitions?.some((ability) => ability.id === "condottiere.blut_im_wasser") &&
      target.hpCurrent / target.hpMax < .3 ? .15 : 0);
  defender.defensePercent = clampCombatPercent((defender.defensePercent ?? 0) +
    (weakness ? -.25-Number(weakness.state.armorBreakPercentPoints??0)/100 : 0));
  defender.damageTakenPercent = (defender.damageTakenPercent ?? 0) +
    (target.abilityDefinitions?.some((ability) => ability.id === "gardist.standhaft") ? -.1 : 0) +
    (effects.some((effect) => effect.targetCombatantId === target.id && effect.abilityId === "gardist.schildwall" &&
      isOpponentPhaseEffectActive(effect.state, combat.roundNumber)) ? -.3 : 0) +
    (effects.some((effect) => effect.targetCombatantId === target.id && effect.abilityId === "condottiere.duell" &&
      (effect.expiresAtRound == null || effect.expiresAtRound >= combat.roundNumber)) ? .15 : 0);
  if (dust) await db.delete(combatEffects).where(eq(combatEffects.id, dust.id));
  return calculateCombatDamage(attacker, defender, multiplier);
}

async function addEffect(combat: CombatInstance, source: Combatant, target: Combatant, abilityId: AbilityId,
  expiresAtRound?: number, state: Record<string, number | boolean> = {}) {
  if (typeof state.shield === "number") {
    const existing = await db.select().from(combatEffects).where(and(
      eq(combatEffects.combatInstanceId, combat.id), eq(combatEffects.targetCombatantId, target.id)));
    const currentShield = existing.reduce((sum, effect) => sum +
      (typeof effect.state.shield === "number" ? effect.state.shield : 0), 0);
    const scaledShield = Math.floor(state.shield * (source.modeMultiplier ?? 1) + .5);
    state = { ...state, shield: Math.max(0, Math.min(scaledShield, target.hpMax * .5 - currentShield)) };
  }
  await db.insert(combatEffects).values({ combatInstanceId: combat.id, sourceCombatantId: source.id,
    targetCombatantId: target.id, abilityId, expiresAtRound: expiresAtRound ?? null, state });
  if (combat.type === "BOSS" && target.entityType === "ENEMY" &&
    ABILITY_DEFINITIONS[abilityId].effect.kind === "DAMAGE_AND_DEFENSE_REDUCTION") {
    await recordBossContribution(combat, source, "DEBUFF", 15, abilityId);
  }
}

async function expireOpponentPhaseEffects(combatId: string, resolvedRound: number): Promise<void> {
  const effects = await db.select().from(combatEffects).where(and(
    eq(combatEffects.combatInstanceId, combatId), eq(combatEffects.abilityId, "gardist.schildwall")));
  const expiredIds = effects.filter((effect) =>
    hasOpponentPhaseCompleted(effect.state, resolvedRound)).map((effect) => effect.id);
  if (expiredIds.length > 0) await db.delete(combatEffects).where(inArray(combatEffects.id, expiredIds));
}

/** Shared damage pipeline used by normal attacks and every ability in PvE, PvP and boss instances. */
async function applyAbilityModifiers(combat: CombatInstance, attacker: Combatant, target: Combatant,
  rawDamage: number, allowBodyguard = true): Promise<number> {
  const allEffects = await db.select().from(combatEffects).where(eq(combatEffects.combatInstanceId, combat.id));
  const active = allEffects.filter((item) => item.expiresAtRound == null || item.expiresAtRound >= combat.roundNumber);
  let damage = rawDamage;
  const smoke=active.find(item=>item.targetCombatantId===target.id&&item.abilityId==="item.rauchkugel");
  if(smoke){damage*=.75;await db.delete(combatEffects).where(eq(combatEffects.id,smoke.id));}
  if(active.some(item=>item.targetCombatantId===target.id&&item.abilityId==="item.geweihter_weihrauch")) damage*=.85;
  if(active.some(item=>item.targetCombatantId===attacker.id&&item.abilityId==="item.adlerstandarte")) damage*=1.15;
  const guard = allowBodyguard ? active.find((item) => item.targetCombatantId === target.id && item.abilityId === "gardist.leibwache") : undefined;
  if (guard) {
    const guardian = combat.combatants.find((item) => item.id === guard.sourceCombatantId && !item.isDowned);
    if (guardian) {
      const transferred = Math.round(damage * .6);
      damage -= transferred;
      await applyAbilityModifiers(combat, attacker, guardian, transferred, false);
    }
  }
  const shield = active.find((item) => item.targetCombatantId === target.id && item.abilityId === "monastic.fuerbitte");
  if (shield) {
    const shieldValue = typeof shield.state.shield === "number" ? shield.state.shield : 0;
    const absorbed = Math.min(shieldValue, Math.round(damage));
    damage -= absorbed;
    if (absorbed === shieldValue) await db.delete(combatEffects).where(eq(combatEffects.id, shield.id));
    else await db.update(combatEffects).set({ state: { ...shield.state, shield: shieldValue - absorbed } }).where(eq(combatEffects.id, shield.id));
  }
  let dealt = Math.max(0, Math.round(damage));
  if(target.entityType==="PLAYER" && dealt>=target.hpCurrent){
    const relic=await db.execute<{id:string}>(sql`UPDATE item_instance i SET quantity=quantity-1 FROM item_def d
      WHERE i.id=(SELECT ii.id FROM item_instance ii WHERE ii.owner_type='PLAYER' AND ii.owner_id=${target.entityId}::uuid
        AND ii.definition_id='notfallreliquie' AND ii.quantity>0 ORDER BY ii.id LIMIT 1 FOR UPDATE SKIP LOCKED)
        AND d.key=i.definition_id RETURNING i.id`);
    if(relic.rows[0]){await db.execute(sql`DELETE FROM item_instance WHERE id=${relic.rows[0].id}::uuid AND quantity=0`);dealt=Math.max(0,target.hpCurrent-1);}
  }
  const wasAlive = target.hpCurrent > 0;
  target.hpCurrent = Math.max(0, target.hpCurrent - dealt);
  target.isDowned = target.hpCurrent === 0;
  await db.update(combatants).set({ hpCurrent: target.hpCurrent }).where(eq(combatants.id, target.id));
  if (target.entityType === "PLAYER") {
    await db.update(players).set({ hpCurrent: Math.floor(target.hpCurrent / (target.modeMultiplier ?? 1) + .5),
      status: target.isDowned ? "DOWNED" : "ACTIVE" }).where(eq(players.id, target.entityId));
    if (wasAlive && target.isDowned && target.teamId) await db.insert(ledgerEntries).values({
      teamId: target.teamId, playerId: target.entityId, currencyType: "DENARII", amount: -10,
      source: "COMBAT", idempotencyKey: uuidv5(`${combat.id}:${target.id}:downed:${combat.roundNumber}`, COMBAT_UUID_NAMESPACE),
    }).onConflictDoNothing();
  }
  if (target.entityType === "ENEMY") await recordBossContribution(combat, attacker, "DAMAGE", dealt, "damage");
  return dealt;
}

async function recordBossContribution(combat: CombatInstance, actor: Combatant, eventType: string,
  amount: number, sourceAction: string): Promise<void> {
  if (combat.type !== "BOSS" || actor.entityType !== "PLAYER" || !actor.teamId || amount <= 0) return;
  const id = uuidv5(`${combat.id}:${combat.roundNumber}:${actor.id}:${eventType}:${sourceAction}:${amount}`,
    COMBAT_UUID_NAMESPACE);
  await db.execute(sql`INSERT INTO boss_contribution_event(id,combat_id,team_id,player_id,event_type,amount,round_number,source_action)
    VALUES (${id}::uuid,${combat.id}::uuid,${actor.teamId}::uuid,${actor.entityId}::uuid,${eventType},${amount},
      ${combat.roundNumber},${sourceAction}) ON CONFLICT DO NOTHING`);
}

/**
 * Check if combat is complete (all enemies or all players downed).
 */
function checkCombatComplete(combat: CombatInstance): boolean {
  if (combat.type === "PVP") {
    const aliveTeams = new Set(combat.combatants.filter((c) => c.entityType === "PLAYER" && !c.isDowned && c.teamId)
      .map((c) => c.teamId));
    return aliveTeams.size <= 1;
  }
  const aliveEnemies = combat.combatants.filter(
    (c) => c.entityType === "ENEMY" && !c.isDowned
  );
  const alivePlayers = combat.combatants.filter(
    (c) => c.entityType === "PLAYER" && !c.isDowned
  );

  return aliveEnemies.length === 0 || alivePlayers.length === 0;
}

/**
 * Get active combat for a team (if any).
 */
export async function getActiveCombatForTeam(
  teamId: string
): Promise<CombatInstance | null> {
  const activeCombats = await db
    .select()
    .from(combatInstances)
    .where(
      inArray(combatInstances.state, ["INITIALIZING", "AWAITING_ACTIONS", "LOCKED", "RESOLVING"])
    );

  for (const combat of activeCombats) {
    const combatantsList = await db
      .select()
      .from(combatants)
      .where(
        and(
          eq(combatants.combatInstanceId, combat.id),
          eq(combatants.teamId, teamId)
        )
      );

    if (combatantsList.length > 0) {
      return getCombatInstance(combat.id);
    }
  }

  return null;
}

/** Apply GDD 24.10 defeat costs and create the server-side respawn state. */
export async function handleTeamWipe(opts: {
  teamId: string;
  combatId?: string;
  wsHub?: WsHub;
}): Promise<void> {
  const { teamId, combatId = teamId, wsHub } = opts;

  // GDD 24.10: -10 denarii per downed player, then 10% current denarii and
  // 3% current fame (maximum 100) for the full wipe. Players remain DOWNED
  // until presence at the server-selected respawn point is confirmed.
  const balance = await db.execute<{ denarii: string; fame: string }>(sql`
    SELECT COALESCE(SUM(amount) FILTER (WHERE currency_type='DENARII'),0)::text denarii,
           COALESCE(SUM(amount) FILTER (WHERE currency_type='FAME'),0)::text fame
    FROM ledger_entry WHERE team_id=${teamId}::uuid`);
  const current = balance.rows[0] ?? { denarii: "0", fame: "0" };
  const denariiPenalty = Math.floor(Math.max(0, Number(current.denarii)) * .1);
  const famePenalty = Math.min(100, Math.floor(Math.max(0, Number(current.fame)) * .03));
  if (denariiPenalty > 0) await db.insert(ledgerEntries).values({ teamId, currencyType: "DENARII",
    amount: -denariiPenalty, source: "COMBAT", idempotencyKey: uuidv5(`${combatId}:${teamId}:wipe:denarii`, COMBAT_UUID_NAMESPACE) }).onConflictDoNothing();
  if (famePenalty > 0) await db.insert(ledgerEntries).values({ teamId, currencyType: "FAME",
    amount: -famePenalty, source: "COMBAT", idempotencyKey: uuidv5(`${combatId}:${teamId}:wipe:fame`, COMBAT_UUID_NAMESPACE) }).onConflictDoNothing();
  const respawn = await db.execute<{ id: string }>(sql`
    SELECT wo.id FROM world_object wo
    JOIN (SELECT AVG(last_lat) lat,AVG(last_lng) lng FROM player WHERE team_id=${teamId}::uuid) team_pos ON true
    WHERE wo.publishable=true AND wo.geom IS NOT NULL
      AND (wo.raw_properties_json::jsonb->>'feature_type'='revive_point'
        OR wo.raw_properties_json::jsonb->'support_roles' ? 'REVIVE_POINT')
    ORDER BY ST_DistanceSphere(wo.geom,ST_SetSRID(ST_MakePoint(team_pos.lng,team_pos.lat),4326)) LIMIT 1`);
  if (respawn.rows[0]) await db.execute(sql`INSERT INTO team_respawn_state(team_id,combat_id,world_object_id)
    VALUES (${teamId}::uuid,${combatId}::uuid,${respawn.rows[0].id}::uuid)
    ON CONFLICT (team_id) DO UPDATE SET combat_id=EXCLUDED.combat_id,world_object_id=EXCLUDED.world_object_id,
      state='RESPAWN_PENDING',started_at=now(),recovered_at=NULL`);

  if (wsHub) {
    wsHub.sendToTeam(teamId, {
      event: "team:wiped",
      data: { message: `Team besiegt: -${denariiPenalty} Denare, -${famePenalty} Ruhm. Rückkehr am Respawnpunkt erforderlich.` },
    });
  }
}

export async function checkRespawnArrival(opts: { teamId: string; lat: number; lng: number; accuracy: number }): Promise<boolean> {
  const state = await db.execute<{ world_object_id: string; distance: string }>(sql`
    SELECT r.world_object_id, GREATEST(0,ST_DistanceSphere(wo.geom,
      ST_SetSRID(ST_MakePoint(${opts.lng},${opts.lat}),4326))-${Math.max(0, opts.accuracy)})::text distance
    FROM team_respawn_state r JOIN world_object wo ON wo.id=r.world_object_id
    WHERE r.team_id=${opts.teamId}::uuid AND r.state<>'RECOVERED'`);
  if (!state.rows[0] || Number(state.rows[0].distance) > 15) return false;
  await db.transaction(async (tx) => {
    const recovered = await tx.execute(sql`UPDATE team_respawn_state SET state='RECOVERED',recovered_at=now()
      WHERE team_id=${opts.teamId}::uuid AND state<>'RECOVERED' RETURNING team_id`);
    if (!recovered.rows.length) return;
    const teamPlayers = await tx.select().from(players).where(eq(players.teamId, opts.teamId));
    for (const player of teamPlayers) {
      if (!player.class) continue;
      const hp = (await getPlayerStats(player)).hpMax;
      await tx.update(players).set({ hpCurrent: hp, status: "ACTIVE" }).where(eq(players.id, player.id));
    }
  });
  return true;
}

async function grantPvPProtection(teamId: string): Promise<void> {
  const startsAt = new Date();
  await db.insert(pvpProtections).values({ teamId, startsAt,
    endsAt: new Date(startsAt.getTime() + PVP_PROTECTION_MS), reason: "PVP_DEFEAT" }).onConflictDoUpdate({
      target: pvpProtections.teamId,
      set: { startsAt, endsAt: new Date(startsAt.getTime() + PVP_PROTECTION_MS), reason: "PVP_DEFEAT" },
    });
}

async function awardPvPFame(combatId: string, winnerTeamId: string, loserTeamId?: string): Promise<void> {
  if (!loserTeamId) return;
  const previous = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text count FROM combat_instance
    WHERE type='PVP' AND state='COMPLETED' AND winner_team_id=${winnerTeamId}::uuid
      AND id<>${combatId}::uuid AND completed_at::date=CURRENT_DATE
      AND id IN (SELECT combat_instance_id FROM combatant WHERE team_id=${loserTeamId}::uuid)`);
  const amount = Number(previous.rows[0]?.count ?? 0) === 0 ? 50 : 25;
  await db.insert(ledgerEntries).values({ teamId: winnerTeamId, currencyType: "FAME", amount,
    source: "COMBAT", idempotencyKey: uuidv5(`${combatId}:pvp:fame`, COMBAT_UUID_NAMESPACE) }).onConflictDoNothing();
}

async function transferPvPLoot(combatId: string, winnerTeamId: string, loserTeamId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`INSERT INTO pvp_loot_resolution
      (combat_id,winner_team_id,loser_team_id) VALUES (${combatId}::uuid,${winnerTeamId}::uuid,${loserTeamId}::uuid)
      ON CONFLICT DO NOTHING RETURNING combat_id`);
    if (!claimed.rows.length) return;
    const transferred: Array<{ itemId: string; quantity: number }> = [];
    const consumables = await tx.execute<{ id: string; quantity: number }>(sql`
      SELECT i.id,i.quantity FROM item_instance i JOIN player p ON p.id=i.owner_id
      WHERE p.team_id=${loserTeamId}::uuid AND i.owner_type='PLAYER' AND i.category='CONSUMABLE'
        AND i.is_bound=false AND i.is_quest_locked=false AND NOT EXISTS(SELECT 1 FROM combat_item_action cia WHERE cia.item_instance_id=i.id AND cia.resolved_at IS NULL) ORDER BY i.id FOR UPDATE`);
    let remaining = randomInt(3, 6);
    for (const item of consumables.rows) {
      if (remaining <= 0) break;
      const amount = Math.min(remaining, item.quantity);
      if (amount === item.quantity) await tx.execute(sql`UPDATE item_instance SET owner_type='TEAM',owner_id=${winnerTeamId}::uuid WHERE id=${item.id}::uuid`);
      else {
        await tx.execute(sql`UPDATE item_instance SET quantity=quantity-${amount} WHERE id=${item.id}::uuid`);
        await tx.execute(sql`INSERT INTO item_instance (definition_id,owner_type,owner_id,quantity,category,is_equipped,is_bound)
          SELECT definition_id,'TEAM',${winnerTeamId}::uuid,${amount},category,false,false FROM item_instance WHERE id=${item.id}::uuid`);
      }
      transferred.push({ itemId: item.id, quantity: amount }); remaining -= amount;
    }
    const equipment = await tx.execute<{ id: string; player_id: string }>(sql`
      SELECT i.id,p.id player_id FROM item_instance i JOIN player p ON p.id=i.owner_id
      WHERE p.team_id=${loserTeamId}::uuid AND i.owner_type='PLAYER' AND i.category='EQUIPMENT'
        AND i.is_equipped=false AND i.is_bound=false AND i.is_quest_locked=false ORDER BY p.id,i.id FOR UPDATE`);
    for (const playerId of [...new Set(equipment.rows.map((row) => row.player_id))]) {
      const candidates = equipment.rows.filter((row) => row.player_id === playerId);
      for (const item of candidates.slice(0, randomInt(0, Math.min(3, candidates.length) + 1))) {
        await tx.execute(sql`UPDATE item_instance SET owner_type='TEAM',owner_id=${winnerTeamId}::uuid WHERE id=${item.id}::uuid`);
        transferred.push({ itemId: item.id, quantity: 1 });
      }
    }
    await tx.execute(sql`UPDATE pvp_loot_resolution SET transferred=${JSON.stringify(transferred)}::jsonb WHERE combat_id=${combatId}::uuid`);
  });
}

async function resolvePvEQuestVictory(combat: CombatInstance, teamId: string, wsHub?: WsHub): Promise<void> {
  const enemy = combat.combatants.find((combatant) => combatant.entityType === "ENEMY");
  const player = combat.combatants.find((combatant) => combatant.entityType === "PLAYER" && combatant.teamId === teamId);
  if (!enemy || !player) return;
  const context = await db.execute<{ account_id: string; quest_run_id: string; step_id: string }>(sql`
    SELECT p.account_id, qr.id quest_run_id, qs.step_id
    FROM player p JOIN quest_run qr ON qr.team_id=p.team_id AND qr.state='ACTIVE'
    JOIN quest_step qs ON qs.quest_definition_id=qr.quest_definition_id
    JOIN world_object wo ON wo.id=${enemy.entityId}::uuid
    LEFT JOIN objective_progress op ON op.quest_run_id=qr.id AND op.objective_id=qs.step_id
    WHERE p.id=${player.entityId}::uuid AND qs.step_action_type='DEFEAT_ENEMY'
      AND qs.flow_phase='OBJECTIVE'
      AND (qs.target_ref=wo.external_id
        OR CONCAT('enemy:',qs.target_ref)=wo.external_id
        OR qs.target_ref=REPLACE(wo.external_id,'enemy:',''))
      AND COALESCE(op.status,'PENDING')<>'COMPLETED'
      AND qs.sequence=(SELECT MIN(next.sequence) FROM quest_step next
        LEFT JOIN objective_progress next_op ON next_op.quest_run_id=qr.id AND next_op.objective_id=next.step_id
        WHERE next.quest_definition_id=qr.quest_definition_id AND next.flow_phase='OBJECTIVE'
          AND COALESCE(next_op.status,'PENDING')<>'COMPLETED')
    LIMIT 1`);
  const row = context.rows[0];
  if (row) await resolveDefeatEnemy({ accountId: row.account_id, questRunId: row.quest_run_id,
    stepId: row.step_id, ...(wsHub ? { wsHub } : {}) });
}

const BOSS_REWARDS = {
  1: [{ fame: 220, denarii: 130, rarity: "L" }, { fame: 170, denarii: 100, rarity: "E" },
    { fame: 130, denarii: 80, rarity: "SSR" }, { fame: 100, denarii: 60, rarity: "SR" }],
  2: [{ fame: 700, denarii: 0, rarity: "L" }, { fame: 500, denarii: 0, rarity: "L" },
    { fame: 350, denarii: 0, rarity: "E" }, { fame: 200, denarii: 0, rarity: "SSR" }],
} as const;

async function finalizeBossRewards(combat: CombatInstance): Promise<void> {
  const boss = combat.combatants.find((candidate) => candidate.entityType === "ENEMY");
  if (!boss) return;
  const [world] = await db.select({ day: worldObjects.day }).from(worldObjects).where(eq(worldObjects.id, boss.entityId));
  const day = world?.day === "DAY_2" || world?.day === "2" ? 2 : 1;
  const contribution = await db.execute<{ team_id: string; score: string; roster: string }>(sql`
    SELECT participants.team_id,COALESCE(SUM(c.amount),0)::text score,
      (SELECT COUNT(*) FROM player p WHERE p.team_id=participants.team_id)::text roster
    FROM (SELECT DISTINCT team_id FROM combatant WHERE combat_instance_id=${combat.id}::uuid AND team_id IS NOT NULL) participants
    LEFT JOIN boss_contribution_event c ON c.combat_id=${combat.id}::uuid AND c.team_id=participants.team_id
    GROUP BY participants.team_id`);
  const ordered = contribution.rows.map((row) => ({ teamId: row.team_id,
    score: Number(row.score) * (Number(row.roster) === 4 ? .75 : 1) })).sort((a, b) => b.score - a.score || a.teamId.localeCompare(b.teamId));
  const ranked = ordered.map((team, index) => {
    const tied = ordered.filter((candidate) => candidate.score === team.score);
    const lowerSharedRank = Math.max(...tied.map((candidate) => ordered.indexOf(candidate) + 1));
    return { ...team, rank: Math.min(4, lowerSharedRank || index + 1) };
  });
  const claimed = await db.execute(sql`INSERT INTO boss_resolution(combat_id,result)
    VALUES (${combat.id}::uuid,${JSON.stringify({ day, ranked })}::jsonb) ON CONFLICT DO NOTHING RETURNING combat_id`);
  if (!claimed.rows.length) return;
  for (const team of ranked) {
    const reward = BOSS_REWARDS[day][team.rank - 1]!;
    await db.insert(ledgerEntries).values({ teamId: team.teamId, currencyType: "FAME", amount: reward.fame,
      source: "COMBAT", idempotencyKey: uuidv5(`${combat.id}:${team.teamId}:boss:fame`, COMBAT_UUID_NAMESPACE) }).onConflictDoNothing();
    if (reward.denarii) await db.insert(ledgerEntries).values({ teamId: team.teamId, currencyType: "DENARII", amount: reward.denarii,
      source: "COMBAT", idempotencyKey: uuidv5(`${combat.id}:${team.teamId}:boss:denarii`, COMBAT_UUID_NAMESPACE) }).onConflictDoNothing();
    const definition = await db.execute<{ key: string }>(sql`SELECT key FROM item_def WHERE rarity=${reward.rarity}::item_rarity
      AND category='EQUIPMENT' ORDER BY key LIMIT 1`);
    if (definition.rows[0]) await db.execute(sql`INSERT INTO item_instance
      (id,definition_id,owner_type,owner_id,quantity,category,is_equipped,is_bound)
      VALUES (${uuidv5(`${combat.id}:${team.teamId}:boss:item`, COMBAT_UUID_NAMESPACE)}::uuid,
        ${definition.rows[0].key},'TEAM',${team.teamId}::uuid,1,'EQUIPMENT',false,false) ON CONFLICT (id) DO NOTHING`);
  }
}

/**
 * Regenerate HP out of combat.
 */
export async function regenerateHPOutOfCombat(playerId: string): Promise<void> {
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.id, playerId));

  if (!player || player.status === "DOWNED") return;

  // Check if player is in combat
  const activeCombat = await getActiveCombatForTeam(player.teamId);
  if (activeCombat) return;

  // The GDD-defined 900-second linear regeneration is materialized centrally.
  await materializeHealthRegeneration(playerId);
}

// ── PvP Challenge System (Epic 6) ────────────────────────────────────────────

/**
 * Check if two teams are within PvP visibility range (60m).
 */
export async function checkPvPProximity(opts: {
  teamId: string;
  playerLat: number;
  playerLng: number;
}): Promise<{
  nearbyTeams: Array<{ teamId: string; teamName: string; distanceM: number }>;
}> {
  const { teamId, playerLat, playerLng } = opts;

  // Get all other teams' last known positions
  const otherTeamPlayers = await db
    .select({
      teamId: players.teamId,
      teamName: teams.name,
      lastLat: players.lastLat,
      lastLng: players.lastLng,
    })
    .from(players)
    .innerJoin(teams, eq(teams.id, players.teamId))
    .where(and(
      sql`${players.teamId} != ${teamId}`,
      sql`${players.lastLat} IS NOT NULL`,
      sql`${players.lastLng} IS NOT NULL`
    ));

  const nearbyTeams: Array<{ teamId: string; teamName: string; distanceM: number }> = [];

  for (const otherPlayer of otherTeamPlayers) {
    if (!otherPlayer.lastLat || !otherPlayer.lastLng) continue;

    // Calculate distance using PostGIS
    const result = await db.execute<{ distance_m: string }>(sql`
      SELECT ST_DistanceSphere(
        ST_MakePoint(${playerLng}, ${playerLat}),
        ST_MakePoint(${otherPlayer.lastLng}, ${otherPlayer.lastLat})
      ) AS distance_m
    `);

    const rows = result.rows as { distance_m: string }[];
    const distanceM = parseFloat(rows[0]?.distance_m ?? "Infinity");

    if (distanceM <= PVP_VISIBILITY_RADIUS_M) {
      nearbyTeams.push({
        teamId: otherPlayer.teamId,
        teamName: otherPlayer.teamName,
        distanceM,
      });
    }
  }

  return { nearbyTeams };
}

export async function checkPvPEscape(teamId: string, wsHub?: WsHub): Promise<void> {
  const warnings = await db.select().from(pvpChallenges).where(and(eq(pvpChallenges.state, "WARNING"),
    sql`(${pvpChallenges.attackerTeamId}=${teamId}::uuid OR ${pvpChallenges.defenderTeamId}=${teamId}::uuid)`));
  for (const warning of warnings) {
    const distance = await db.execute<{ distance: string }>(sql`
      SELECT MIN(GREATEST(0,ST_DistanceSphere(ST_MakePoint(a.last_lng,a.last_lat),
        ST_MakePoint(d.last_lng,d.last_lat))-COALESCE(a.last_accuracy,0)-COALESCE(d.last_accuracy,0)))::text distance
      FROM player a CROSS JOIN player d WHERE a.team_id=${warning.attackerTeamId}::uuid
        AND d.team_id=${warning.defenderTeamId}::uuid AND a.status='ACTIVE' AND d.status='ACTIVE'
        AND a.last_location_update>now()-interval '30 seconds' AND d.last_location_update>now()-interval '30 seconds'`);
    const escapedSample = Number(distance.rows[0]?.distance ?? 0) > PVP_ESCAPE_RADIUS_M;
    const [updated] = await db.update(pvpChallenges).set({ escapeConfirmations: escapedSample
      ? sql`${pvpChallenges.escapeConfirmations} + 1` : 0 }).where(and(eq(pvpChallenges.id, warning.id),
        eq(pvpChallenges.state, "WARNING"))).returning();
    if ((updated?.escapeConfirmations ?? 0) >= 2) {
      await db.update(pvpChallenges).set({ state: "ESCAPED" }).where(and(eq(pvpChallenges.id, warning.id),
        eq(pvpChallenges.state, "WARNING")));
      if (wsHub) for (const targetTeamId of [warning.attackerTeamId, warning.defenderTeamId]) wsHub.sendToTeam(targetTeamId,
        { event: "pvp:challenge_escaped", data: { challengeId: warning.id, reason: "distance" } });
    }
  }
}

/**
 * Check if a location is in a safe zone.
 */
export async function isInSafeZone(opts: {
  lat: number;
  lng: number;
}): Promise<boolean> {
  const { lat, lng } = opts;

  // Query for nearby SAFE_ZONE WorldObjects
  const result = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*) as count
    FROM world_object wo
    WHERE
      wo.type = 'SAFE_ZONE'
      AND wo.geom IS NOT NULL
      AND wo.publishable = true
      AND ST_DWithin(
        wo.geom::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        wo.interaction_radius_m
      )
  `);

  const rows = result.rows as { count: string }[];
  const count = parseInt(rows[0]?.count ?? "0");

  return count > 0;
}

/**
 * Start a PvP challenge between two teams.
 * Creates a WARNING state that lasts 20 seconds before combat starts.
 */
export async function startPvPChallenge(opts: {
  attackerTeamId: string;
  defenderTeamId: string;
  wsHub?: WsHub;
}): Promise<{
  challengeId: string;
  expiresAt: Date;
}> {
  const { attackerTeamId, defenderTeamId, wsHub } = opts;
  if (attackerTeamId === defenderTeamId) throw new Error("A team cannot challenge itself");

  // Check if either team is already in combat
  const attackerCombat = await getActiveCombatForTeam(attackerTeamId);
  const defenderCombat = await getActiveCombatForTeam(defenderTeamId);

  if (attackerCombat || defenderCombat) {
    throw new Error("One or both teams are already in combat");
  }

  const protectedRows = await db.select().from(pvpProtections).where(and(
    inArray(pvpProtections.teamId, [attackerTeamId, defenderTeamId]),
    sql`${pvpProtections.endsAt} > now()`));
  if (protectedRows.length) throw new Error("One or both teams are PvP protected");

  const eligible = await db.execute<{ team_id: string; last_lat: number; last_lng: number; last_accuracy: number | null }>(sql`
    SELECT DISTINCT ON (team_id) team_id, last_lat, last_lng,last_accuracy FROM player
    WHERE team_id IN (${attackerTeamId}::uuid, ${defenderTeamId}::uuid)
      AND status='ACTIVE' AND last_lat IS NOT NULL AND last_lng IS NOT NULL
      AND last_location_update > now() - interval '30 seconds'
    ORDER BY team_id, last_location_update DESC`);
  const attackerPosition = eligible.rows.find((row) => row.team_id === attackerTeamId);
  const defenderPosition = eligible.rows.find((row) => row.team_id === defenderTeamId);
  if (!attackerPosition || !defenderPosition) throw new Error("Both teams need a fresh valid position");
  const initialDistance = await distanceBetween(attackerPosition, defenderPosition);
  if (initialDistance > PVP_AGGRO_RADIUS_M) throw new Error("Target team is outside the 20 metre attack radius");
  if (await isInSafeZone({ lat: attackerPosition.last_lat, lng: attackerPosition.last_lng }) ||
      await isInSafeZone({ lat: defenderPosition.last_lat, lng: defenderPosition.last_lng })) {
    throw new Error("PvP is not allowed in a safe zone");
  }

  // Check if defender is in safe zone
  const [defenderPlayer] = await db
    .select({ lastLat: players.lastLat, lastLng: players.lastLng })
    .from(players)
    .where(eq(players.teamId, defenderTeamId))
    .limit(1);

  if (defenderPlayer?.lastLat && defenderPlayer?.lastLng) {
    const inSafeZone = await isInSafeZone({
      lat: defenderPlayer.lastLat,
      lng: defenderPlayer.lastLng,
    });

    if (inSafeZone) {
      throw new Error("Defender is in a safe zone - PvP not allowed");
    }
  }

  // Create PvP challenge
  const expiresAt = new Date(Date.now() + PVP_WARNING_TIMER_MS);

  const challengeResults = await db.transaction(async (tx) => {
    for (const id of [attackerTeamId, defenderTeamId].sort()) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
    }
    const conflict = await tx.select().from(pvpChallenges).where(and(eq(pvpChallenges.state, "WARNING"),
      sql`(${pvpChallenges.attackerTeamId} IN (${attackerTeamId}::uuid,${defenderTeamId}::uuid)
        OR ${pvpChallenges.defenderTeamId} IN (${attackerTeamId}::uuid,${defenderTeamId}::uuid))`));
    if (conflict.length) throw new Error("One or both teams are already reserved by a PvP warning");
    return tx.insert(pvpChallenges).values({ attackerTeamId, defenderTeamId, state: "WARNING", expiresAt }).returning();
  });

  const challenge = challengeResults[0];
  if (!challenge) {
    throw new Error("Failed to create PvP challenge");
  }

  // Emit WS events to both teams
  if (wsHub) {
    wsHub.sendToTeam(attackerTeamId, {
      event: "pvp:challenge_started",
      data: {
        challengeId: challenge.id,
        role: "attacker",
        opponentTeamId: defenderTeamId,
        expiresAt: expiresAt.toISOString(),
        currentDistanceM: initialDistance,
        escapeDistanceM: PVP_ESCAPE_RADIUS_M,
      },
    });

    wsHub.sendToTeam(defenderTeamId, {
      event: "pvp:challenge_started",
      data: {
        challengeId: challenge.id,
        role: "defender",
        opponentTeamId: attackerTeamId,
        expiresAt: expiresAt.toISOString(),
        currentDistanceM: initialDistance,
        escapeDistanceM: PVP_ESCAPE_RADIUS_M,
      },
    });
  }

  // Schedule auto-escalation to combat
  schedulePvPEscalation(challenge.id, PVP_WARNING_TIMER_MS, wsHub);

  return {
    challengeId: challenge.id,
    expiresAt,
  };
}

/**
 * Schedule PvP challenge escalation to combat.
 */
function schedulePvPEscalation(challengeId: string, delayMs: number, wsHub?: WsHub) {
  setTimeout(async () => {
    try {
      await escalatePvPChallenge(challengeId, wsHub);
    } catch (err) {
      console.error(`Failed to escalate PvP challenge ${challengeId}:`, err);
    }
  }, delayMs);
}

/**
 * Escalate PvP challenge to combat after warning period.
 */
async function escalatePvPChallenge(challengeId: string, wsHub?: WsHub): Promise<void> {
  const challenges = await db
    .select()
    .from(pvpChallenges)
    .where(eq(pvpChallenges.id, challengeId));

  const challenge = challenges[0];
  if (!challenge || challenge.state !== "WARNING") {
    return; // Already resolved
  }

  // Check if defender escaped (GPS validation)
  const [attacker] = await db
    .select({ lastLat: players.lastLat, lastLng: players.lastLng })
    .from(players)
    .where(eq(players.teamId, challenge.attackerTeamId))
    .limit(1);

  const [defender] = await db
    .select({ lastLat: players.lastLat, lastLng: players.lastLng })
    .from(players)
    .where(eq(players.teamId, challenge.defenderTeamId))
    .limit(1);

  if (!attacker?.lastLat || !attacker?.lastLng || !defender?.lastLat || !defender?.lastLng) {
    // GDD 23.12: stale/missing GPS must cause neither a free escape nor an
    // unfair combat start. Keep the reservation and retry with a server deadline.
    const retryAt = new Date(Date.now() + 10_000);
    await db.update(pvpChallenges).set({ expiresAt: retryAt }).where(eq(pvpChallenges.id, challengeId));
    schedulePvPEscalation(challengeId, 10_000, wsHub);
    return;
  }

  // Check safe zone
  const inSafeZone = await isInSafeZone({
    lat: defender.lastLat,
    lng: defender.lastLng,
  });

  if (inSafeZone) {
    // Defender reached safe zone
    await db
      .update(pvpChallenges)
      .set({ state: "ESCAPED" })
      .where(eq(pvpChallenges.id, challengeId));

    if (wsHub) {
      wsHub.sendToTeam(challenge.attackerTeamId, {
        event: "pvp:challenge_escaped",
        data: { challengeId, reason: "safe_zone" },
      });
      wsHub.sendToTeam(challenge.defenderTeamId, {
        event: "pvp:challenge_escaped",
        data: { challengeId, reason: "safe_zone" },
      });
    }
    return;
  }

  // Start PvP combat!
  await db
    .update(pvpChallenges)
    .set({ state: "COMBAT" })
    .where(eq(pvpChallenges.id, challengeId));

  try {
    if (wsHub) {
      await startPvPCombat({
        attackerTeamId: challenge.attackerTeamId,
        defenderTeamId: challenge.defenderTeamId,
        wsHub,
      });
    } else {
      await startPvPCombat({
        attackerTeamId: challenge.attackerTeamId,
        defenderTeamId: challenge.defenderTeamId,
      });
    }
  } catch (err) {
    console.error("Failed to start PvP combat:", err);
  }
}

async function distanceBetween(a: { last_lat: number; last_lng: number; last_accuracy?: number | null }, b: { last_lat: number; last_lng: number; last_accuracy?: number | null }): Promise<number> {
  const result = await db.execute<{ distance_m: string }>(sql`SELECT ST_DistanceSphere(
    ST_MakePoint(${a.last_lng}, ${a.last_lat}), ST_MakePoint(${b.last_lng}, ${b.last_lat})) AS distance_m`);
  return Math.max(0, Number(result.rows[0]?.distance_m ?? Infinity) - (a.last_accuracy ?? 0) - (b.last_accuracy ?? 0));
}

/**
 * Start PvP combat between two teams.
 */
async function startPvPCombat(opts: {
  attackerTeamId: string;
  defenderTeamId: string;
  wsHub?: WsHub;
}): Promise<CombatInstance> {
  const { attackerTeamId, defenderTeamId, wsHub } = opts;
  await Promise.all([markTeamRegenStopped(attackerTeamId), markTeamRegenStopped(defenderTeamId)]);

  // Get both teams' players
  const attackerTeamPlayers = await db
    .select()
    .from(players)
    .where(eq(players.teamId, attackerTeamId));

  const defenderTeamPlayers = await db
    .select()
    .from(players)
    .where(eq(players.teamId, defenderTeamId));

  const spatiallyEligible = async (player: typeof players.$inferSelect, opponents: Array<typeof players.$inferSelect>) => {
    if (player.status !== "ACTIVE" || player.lastLat == null || player.lastLng == null || !player.lastLocationUpdate ||
      Date.now() - player.lastLocationUpdate.getTime() > 30_000) return false;
    const distances = await Promise.all(opponents.filter((opponent) => opponent.status === "ACTIVE" && opponent.lastLat != null && opponent.lastLng != null)
      .map((opponent) => distanceBetween({ last_lat: player.lastLat!, last_lng: player.lastLng!, last_accuracy: player.lastAccuracy },
        { last_lat: opponent.lastLat!, last_lng: opponent.lastLng!, last_accuracy: opponent.lastAccuracy })));
    return distances.some((distance) => distance <= PVP_AGGRO_RADIUS_M);
  };
  const attackerPlayers = (await Promise.all(attackerTeamPlayers.map(async (player) =>
    ({ player, eligible: await spatiallyEligible(player, defenderTeamPlayers) })))).filter((row) => row.eligible).map((row) => row.player);
  const defenderPlayers = (await Promise.all(defenderTeamPlayers.map(async (player) =>
    ({ player, eligible: await spatiallyEligible(player, attackerTeamPlayers) })))).filter((row) => row.eligible).map((row) => row.player);
  if (attackerPlayers.length === 0 || defenderPlayers.length === 0) {
    throw new Error("One or both teams have no players");
  }

  // Create combat instance
  const combatResults = await db
    .insert(combatInstances)
    .values({
      type: "PVP",
      state: "INITIALIZING",
      roundNumber: 0,
    })
    .returning();

  const combat = combatResults[0];
  if (!combat) {
    throw new Error("Failed to create PvP combat instance");
  }

  // Create combatants for both teams
  await Promise.all([
    ...attackerPlayers.map(async (player) => {
      const { hpMax } = await getPlayerStats(player);
      const underdog = attackerPlayers.length === 3 && defenderPlayers.length === 4 ? Math.sqrt(4 / 3) : 1;
      await db.insert(combatants).values({
        combatInstanceId: combat.id,
        entityType: "PLAYER",
        entityId: player.id,
        teamId: player.teamId,
        hpCurrent: Math.min(Math.floor(player.hpCurrent * underdog + .5), Math.floor(hpMax * underdog + .5)),
        modeMultiplier: underdog,
      });
    }),
    ...defenderPlayers.map(async (player) => {
      const { hpMax } = await getPlayerStats(player);
      const underdog = defenderPlayers.length === 3 && attackerPlayers.length === 4 ? Math.sqrt(4 / 3) : 1;
      await db.insert(combatants).values({
        combatInstanceId: combat.id,
        entityType: "PLAYER",
        entityId: player.id,
        teamId: player.teamId,
        hpCurrent: Math.min(Math.floor(player.hpCurrent * underdog + .5), Math.floor(hpMax * underdog + .5)),
        modeMultiplier: underdog,
      });
    }),
  ]);

  // Start round 1
  await db
    .update(combatInstances)
    .set({
      state: "AWAITING_ACTIONS",
      roundNumber: 1,
      ...newRoundTiming(),
    })
    .where(eq(combatInstances.id, combat.id));

  scheduleRoundLock(combat.id, ROUND_TIMER_MS, wsHub);

  // Emit WS events
  if (wsHub) {
    wsHub.sendToTeam(attackerTeamId, {
      event: "combat:started",
      data: { combatId: combat.id, type: "PVP", opponentTeamId: defenderTeamId },
    });
    wsHub.sendToTeam(defenderTeamId, {
      event: "combat:started",
      data: { combatId: combat.id, type: "PVP", opponentTeamId: attackerTeamId },
    });
  }

  return getCombatInstance(combat.id);
}
