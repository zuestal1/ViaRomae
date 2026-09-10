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
  combatRoundOrders,
  pvpChallenges,
  statusEffectInstances,
  statusEffectDefinitions,
  abilityCooldowns,
} from "../../db/schema/combat.js";
import { players, teams } from "../../db/schema/player.js";
import { worldObjects } from "../../db/schema/world.js";
import { ledgerEntries } from "../../db/schema/economy.js";
import type { WsHub } from "../ws/ws.hub.js";
import { randomInt, randomUUID } from "node:crypto";
import {
  applyDamage,
  calculateDamage,
  calculateEffectiveInitiative,
  compareRoundOrder,
  calculateEquipmentRarityScore,
  type CombatStats,
  type EquipmentRarity,
} from "./combat-calculation.js";
import { randomUUID } from "node:crypto";
import { materializeHealthRegeneration, markTeamRegenStopped } from "./health-regeneration.service.js";
import { getPlayerStats } from "../player/player-stats.service.js";

// ── Constants ────────────────────────────────────────────────────────────────

const ROUND_TIMER_MS = 15_000; // 15 seconds per round
const PVP_WARNING_TIMER_MS = 20_000; // 20 seconds warning before PvP
const PVP_AGGRO_RADIUS_M = 20;
const PVP_VISIBILITY_RADIUS_M = 60;
const RESPAWN_HP_PERCENTAGE = 0.5; // 50% HP after respawn

// ── Types ────────────────────────────────────────────────────────────────────

export interface CombatInstance {
  id: string;
  type: "PVE" | "PVP" | "BOSS";
  state: "INITIALIZING" | "AWAITING_ACTIONS" | "LOCKED" | "RESOLVING" | "COMPLETED";
  roundNumber: number;
  startedAt: Date;
  combatants: Combatant[];
  actions: CombatAction[];
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
  stats?: CombatStats;
  equipmentRarityScore?: number;
  shield?: number;
  name: string;
  isDowned: boolean;
  activeEffects: ActiveStatusEffect[];
  shield: number;
  cooldowns: AbilityCooldownState[];
}

export interface ActiveStatusEffect {
  id: string;
  effectId: string;
  sourceId: string;
  targetId: string;
  appliedRound: number;
  expiresAfterRound: number | null;
  stacks: number;
  magnitudeOverrides?: Record<string, number>;
  remainingTriggers?: number;
  remainingDurationRounds: number | null;
  shieldRemaining?: number;
}

export interface AbilityCooldownState {
  id: string;
  combatantId: string;
  abilityId: string;
  activatedRound: number;
  readyAfterRound: number;
  remainingRounds: number;
  isReady: boolean;
  deactivationReason?: string;
}

export interface CombatAction {
  id: string;
  roundNumber: number;
  actorId: string;
  actionType: ActionType;
  targetId?: string | undefined;
  isLocked: boolean;
  origin: "PLAYER_SUBMITTED" | "AUTOMATIC" | "ENEMY_AI";
  damage?: number;
  effect?: string;
}

export type ActionType = "ATTACK" | "DEFEND" | "SKILL" | "FLEE";

export interface CombatLog {
  timestamp: Date;
  message: string;
  type: "ACTION" | "DAMAGE" | "EFFECT" | "STATE";
}

const BASE_STATS: CombatStats = { attack: 15, defense: 0, initiative: 50 };

async function loadPlayerProfile(playerId: string): Promise<{
  stats: CombatStats;
  equipmentRarityScore: number;
}> {
  const result = await db.execute<{ stats: string; slot: string }>(sql`
    SELECT d.stats, i.slot FROM item_instance i
    JOIN item_def d ON d.key = i.definition_id
    WHERE i.owner_id = ${playerId} AND i.is_equipped = true
    ORDER BY i.slot, i.id
    LIMIT 4
  `);
  const stats: CombatStats = { ...BASE_STATS };
  const rarities: EquipmentRarity[] = [];
  for (const item of result.rows) {
    const modifiers = JSON.parse(item.stats || "{}") as Record<string, number | string>;
    stats.attack += Number(modifiers.atk ?? modifiers.attack ?? 0);
    stats.defense += Number(modifiers.def ?? modifiers.defense ?? 0);
    stats.initiative += Number(modifiers.init ?? modifiers.initiative ?? 0);
    stats.damageDealtPercent = (stats.damageDealtPercent ?? 0) + Number(modifiers.damageDealtPercent ?? 0);
    stats.defensePercent = (stats.defensePercent ?? 0) + Number(modifiers.defensePercent ?? 0);
    stats.defenseFlat = (stats.defenseFlat ?? 0) + Number(modifiers.defenseFlat ?? 0);
    stats.damageTakenPercent = (stats.damageTakenPercent ?? 0) + Number(modifiers.damageTakenPercent ?? 0);
    stats.initiativePercent = (stats.initiativePercent ?? 0) + Number(modifiers.initiativePercent ?? 0);
    stats.initiativeFlat = (stats.initiativeFlat ?? 0) + Number(modifiers.initiativeFlat ?? 0);
    stats.healingPercent = (stats.healingPercent ?? 0) + Number(modifiers.healingPercent ?? 0);
    const rarity = modifiers.rarity;
    if (["N", "R", "SR", "SSR", "E", "L"].includes(String(rarity))) {
      rarities.push(rarity as EquipmentRarity);
    }
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
  const { teamId, enemyWorldObjectId, wsHub } = opts;

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
      const results = await db
        .insert(combatants)
        .values({
          combatInstanceId: combat.id,
          entityType: "PLAYER",
          entityId: player.id,
          teamId: player.teamId,
          hpCurrent: Math.min(player.hpCurrent, stats.hpMax),
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

  const effectsData = await db.select().from(statusEffectInstances)
    .where(eq(statusEffectInstances.combatInstanceId, combatId));
  const cooldownData = await db.select().from(abilityCooldowns)
    .where(eq(abilityCooldowns.combatInstanceId, combatId));

  // Enrich combatants with names
  const enrichedCombatants: Combatant[] = await Promise.all(
    combatantsData.map(async (c) => {
      let name = "Unknown";
      let hpMax = 0;
      let atk = 0;
      let def = 0;
      let initiative = 0;

      if (c.entityType === "PLAYER") {
        const [player] = await db
          .select()
          .from(players)
          .where(eq(players.id, c.entityId));
        // For simplicity, use entityId as name
        name = player?.accountId.substring(0, 8) ?? "Player";
        if (player) {
          const stats = await getPlayerStats(player);
          ({ hpMax, atk, def, initiative } = stats);
        }
      } else if (c.entityType === "ENEMY") {
        const [enemy] = await db
          .select()
          .from(worldObjects)
          .where(eq(worldObjects.id, c.entityId));
        name = enemy?.name ?? "Enemy";
        enemyProps = enemy?.rawPropertiesJson
          ? JSON.parse(enemy.rawPropertiesJson)
          : {};
        hpMax = enemyProps.hp ?? 100;
        atk = enemyProps.atk ?? enemyProps.attack ?? 10;
        def = enemyProps.def ?? enemyProps.defense ?? 0;
        initiative = enemyProps.initiative ?? 0;
      }

      const profile = c.entityType === "PLAYER"
        ? await loadPlayerProfile(c.entityId)
        : {
            stats: {
              attack: Number(enemyProps.atk ?? enemyProps.attack ?? 15),
              defense: Number(enemyProps.def ?? enemyProps.defense ?? 0),
              initiative: Number(enemyProps.initiative ?? 50),
            },
            equipmentRarityScore: 0,
          };

      return {
        id: c.id,
        entityType: c.entityType as "PLAYER" | "ENEMY",
        entityId: c.entityId,
        teamId: c.teamId ?? undefined,
        hpCurrent: Math.min(c.hpCurrent, hpMax),
        hpMax,
        initiative: calculateEffectiveInitiative(profile.stats),
        stats: profile.stats,
        equipmentRarityScore: profile.equipmentRarityScore,
        shield: 0,
        name,
        isDowned: c.hpCurrent <= 0,
        activeEffects: effectsData.filter((effect) => effect.targetId === c.id
          && (effect.expiresAfterRound === null || effect.expiresAfterRound >= combat.roundNumber)
          && (effect.remainingTriggers === null || effect.remainingTriggers > 0)).map((effect) => ({
          id: effect.id,
          effectId: effect.effectId,
          sourceId: effect.sourceId,
          targetId: effect.targetId,
          appliedRound: effect.appliedRound,
          expiresAfterRound: effect.expiresAfterRound,
          stacks: effect.stacks,
          ...(effect.magnitudeOverrides ? { magnitudeOverrides: effect.magnitudeOverrides } : {}),
          ...(effect.remainingTriggers !== null ? { remainingTriggers: effect.remainingTriggers } : {}),
          remainingDurationRounds: effect.expiresAfterRound === null
            ? null
            : Math.max(0, effect.expiresAfterRound - combat.roundNumber + 1),
          ...(effect.shieldRemaining !== null ? { shieldRemaining: effect.shieldRemaining } : {}),
        })),
        // Shields from distinct effects and sources add, but never above 50% maxHP.
        shield: Math.min(hpMax * 0.5, effectsData.filter((effect) => effect.targetId === c.id
          && (effect.expiresAfterRound === null || effect.expiresAfterRound >= combat.roundNumber)
          && (effect.remainingTriggers === null || effect.remainingTriggers > 0))
          .reduce((sum, effect) => sum + (effect.shieldRemaining ?? 0), 0)),
        cooldowns: cooldownData.filter((cooldown) => cooldown.combatantId === c.id).map((cooldown) => {
          const remainingRounds = Math.max(0, cooldown.readyAfterRound - combat.roundNumber + 1);
          return {
            id: cooldown.id,
            combatantId: cooldown.combatantId,
            abilityId: cooldown.abilityId,
            activatedRound: cooldown.activatedRound,
            readyAfterRound: cooldown.readyAfterRound,
            remainingRounds,
            isReady: remainingRounds === 0,
            ...(remainingRounds > 0 ? {
              deactivationReason: cooldown.deactivationReason
                ?? `Noch ${remainingRounds} ${remainingRounds === 1 ? "Runde" : "Runden"} Abklingzeit`,
            } : {}),
          };
        }),
      };
    })
  );

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
      targetId: a.targetId ?? undefined,
      isLocked: a.isLocked,
      origin: a.origin,
    })),
  };
}

/**
 * Submit a combat action for a player.
 */
export async function submitCombatAction(opts: {
  combatId: string;
  playerId: string;
  actionType: ActionType;
  targetId?: string | undefined;
  idempotencyKey: string;
}): Promise<CombatAction> {
  const { combatId, playerId, actionType, targetId, idempotencyKey } = opts;

  return db.transaction(async (tx) => {
    // Serialize submission and lock. This makes the last transaction accepted
    // before LOCKED the authoritative action for the round.
    await tx.execute(sql`select id from combat_instance where id = ${combatId} for update`);

    const [receipt] = await tx.select().from(combatActionSubmissions)
      .where(eq(combatActionSubmissions.idempotencyKey, idempotencyKey));
    if (receipt) {
      return {
        id: receipt.actionId, roundNumber: receipt.roundNumber, actorId: receipt.actorId,
        actionType: receipt.actionType as ActionType,
        targetId: receipt.targetId ?? undefined, isLocked: false,
        origin: "PLAYER_SUBMITTED" as const,
      };
    }

    const [combat] = await tx.select().from(combatInstances)
      .where(eq(combatInstances.id, combatId));
    if (!combat || combat.state !== "AWAITING_ACTIONS") {
      throw new Error("Combat is not accepting actions");
    }
    const [actor] = await tx.select().from(combatants).where(and(
      eq(combatants.combatInstanceId, combatId),
      eq(combatants.entityId, playerId),
      eq(combatants.entityType, "PLAYER")
    ));
    if (!actor) throw new Error("Player not in combat");
    if (actor.hpCurrent <= 0) throw new Error("Player is downed");

    if (actionType === "ATTACK") {
      if (!targetId) throw new Error("Attack requires a target");
      const [target] = await tx.select().from(combatants).where(and(
        eq(combatants.id, targetId), eq(combatants.combatInstanceId, combatId)
      ));
      if (!target || target.hpCurrent <= 0 || !areOpponents(actor, target)) {
        throw new Error("Invalid attack target");
      }
    }

    const [action] = await tx.insert(combatActions).values({
      combatInstanceId: combatId, roundNumber: combat.roundNumber, actorId: actor.id,
      actionType, targetId: targetId ?? null, isLocked: false,
      origin: "PLAYER_SUBMITTED", idempotencyKey,
    }).onConflictDoUpdate({
      target: [combatActions.combatInstanceId, combatActions.roundNumber, combatActions.actorId],
      set: { actionType, targetId: targetId ?? null, idempotencyKey, origin: "PLAYER_SUBMITTED" },
      setWhere: eq(combatActions.isLocked, false),
    }).returning();
    if (!action) throw new Error("Combat action is locked");

    await tx.insert(combatActionSubmissions).values({
      idempotencyKey, actionId: action.id, combatInstanceId: combatId,
      roundNumber: action.roundNumber, actorId: actor.id, actionType,
      targetId: targetId ?? null,
    });
    return { id: action.id, roundNumber: action.roundNumber, actorId: action.actorId,
      actionType: action.actionType as ActionType, targetId: action.targetId ?? undefined,
      isLocked: action.isLocked, origin: action.origin };
  });
}

function areOpponents(a: typeof combatants.$inferSelect, b: typeof combatants.$inferSelect) {
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
    const alive = participants.filter((c) => c.hpCurrent > 0);
    for (const actor of alive) {
      const targets = alive.filter((target) => areOpponents(actor, target))
        .sort((a, b) => a.id.localeCompare(b.id));
      const target = targets[0];
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
      const stats = snapshot?.stats ?? BASE_STATS;
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
  const logs = await resolveRound(combatId, wsHub);

  // Check for combat end
  const updatedCombat = await getCombatInstance(combatId);
  const isComplete = checkCombatComplete(updatedCombat);

  if (isComplete) {
    await db
      .update(combatInstances)
      .set({ state: "COMPLETED" })
      .where(eq(combatInstances.id, combatId));
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

    if (wsHub && updatedCombat.combatants[0]?.teamId) {
      wsHub.sendToTeam(updatedCombat.combatants[0].teamId, {
        event: "combat:completed",
        data: { combatId, logs, combatants: completedCombat.combatants },
      });
    }
  } else {
    // Start next round
    await db
      .update(combatInstances)
      .set({
        state: "AWAITING_ACTIONS",
        roundNumber: roundNumber + 1,
      })
      .where(eq(combatInstances.id, combatId));

    scheduleRoundLock(combatId, ROUND_TIMER_MS, wsHub);

    if (wsHub && updatedCombat.combatants[0]?.teamId) {
      wsHub.sendToTeam(updatedCombat.combatants[0].teamId, {
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
    const actorA = combat.combatants.find((c) => c.id === a.actorId);
    const actorB = combat.combatants.find((c) => c.id === b.actorId);
    const orderA = orderByActor.get(a.actorId);
    const orderB = orderByActor.get(b.actorId);
    return compareRoundOrder({
      actorId: a.actorId,
      effectiveInitiative: orderA?.effectiveInitiative ?? actorA?.initiative ?? 0,
      equipmentRarityScore: orderA?.equipmentRarityScore ?? actorA?.equipmentRarityScore ?? 0,
      roundRandom: orderA?.roundRandom ?? 0,
    }, {
      actorId: b.actorId,
      effectiveInitiative: orderB?.effectiveInitiative ?? actorB?.initiative ?? 0,
      equipmentRarityScore: orderB?.equipmentRarityScore ?? actorB?.equipmentRarityScore ?? 0,
      roundRandom: orderB?.roundRandom ?? 0,
    });
  });

  // Execute actions in initiative order
  for (const action of sortedActions) {
    const actor = combat.combatants.find((c) => c.id === action.actorId);
    if (!actor || actor.isDowned) continue;

    if (action.actionType === "ATTACK" && action.targetId) {
      const targetMaybe = combat.combatants.find((c) => c.id === action.targetId);
      if (!targetMaybe || targetMaybe.isDowned) continue;
      
      // Calculate damage
      const damage = calculateDamage(
        actor.stats ?? { attack: 15, defense: 0, initiative: actor.initiative },
        targetMaybe.stats ?? { attack: 15, defense: 0, initiative: targetMaybe.initiative },
      );

      // Shields are consumed before HP according to GDD 7.10.
      const result = applyDamage(targetMaybe.hpCurrent, targetMaybe.shield ?? 0, damage);
      const newHp = result.hpAfter;
      await db
        .update(combatants)
        .set({ hpCurrent: newHp })
        .where(eq(combatants.id, targetMaybe.id));

      logs.push({
        timestamp: new Date(),
        message: `${actor.name} attacks ${targetMaybe.name} for ${damage} damage!`,
        type: "DAMAGE",
      });

      if (newHp <= 0) {
        logs.push({
          timestamp: new Date(),
          message: `${targetMaybe.name} is downed!`,
          type: "STATE",
        });

        // Update player status if player
        if (targetMaybe.entityType === "PLAYER") {
          await db
            .update(players)
            .set({ status: "DOWNED" })
            .where(eq(players.id, targetMaybe.entityId));
        }
      }

      // Update combatant in memory
      targetMaybe.hpCurrent = newHp;
      targetMaybe.isDowned = newHp <= 0;
    } else if (action.actionType === "DEFEND") {
      logs.push({
        timestamp: new Date(),
        message: `${actor.name} takes a defensive stance!`,
        type: "ACTION",
      });
    } else if (action.actionType === "FLEE") {
      logs.push({
        timestamp: new Date(),
        message: `${actor.name} attempts to flee!`,
        type: "ACTION",
      });
    }
  }

  return logs;
}

/**
 * Calculate damage for an attack.
 */
function calculateDamage(attacker: Combatant, defender: Combatant): number {
  return Math.max(1, Math.round(attacker.atk - defender.def / 2));
}

/**
 * Check if combat is complete (all enemies or all players downed).
 */
function checkCombatComplete(combat: CombatInstance): boolean {
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

/**
 * Handle team wipe - respawn all players with 50% HP.
 */
export async function handleTeamWipe(opts: {
  teamId: string;
  wsHub?: WsHub;
}): Promise<void> {
  const { teamId, wsHub } = opts;

  const teamPlayers = await db
    .select()
    .from(players)
    .where(eq(players.teamId, teamId));

  for (const player of teamPlayers) {
    const respawnHp = Math.floor(player.maxHp * RESPAWN_HP_PERCENTAGE);
    await db
      .update(players)
      .set({
        hpCurrent: respawnHp,
        status: "ACTIVE",
      })
      .where(eq(players.id, player.id));
  }

  // Deduct denarii penalty
  await db.insert(ledgerEntries).values({
    teamId,
    currencyType: "DENARII",
    amount: -50, // Penalty
    source: "COMBAT",
    idempotencyKey: randomUUID(),
  });

  if (wsHub) {
    wsHub.sendToTeam(teamId, {
      event: "team:wiped",
      data: { message: "Your team has been wiped! Respawning with 50% HP. -50 Denarii." },
    });
  }
}

/**
 * Regenerate HP out of combat.
 */
export async function regenerateHPOutOfCombat(playerId: string): Promise<void> {
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

  // Check if either team is already in combat
  const attackerCombat = await getActiveCombatForTeam(attackerTeamId);
  const defenderCombat = await getActiveCombatForTeam(defenderTeamId);

  if (attackerCombat || defenderCombat) {
    throw new Error("One or both teams are already in combat");
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

  const challengeResults = await db
    .insert(pvpChallenges)
    .values({
      attackerTeamId,
      defenderTeamId,
      state: "WARNING",
      expiresAt,
    })
    .returning();

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
      },
    });

    wsHub.sendToTeam(defenderTeamId, {
      event: "pvp:challenge_started",
      data: {
        challengeId: challenge.id,
        role: "defender",
        opponentTeamId: attackerTeamId,
        expiresAt: expiresAt.toISOString(),
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
    // Missing GPS data, mark as escaped
    await db
      .update(pvpChallenges)
      .set({ state: "ESCAPED" })
      .where(eq(pvpChallenges.id, challengeId));
    return;
  }

  // Calculate current distance
  const result = await db.execute<{ distance_m: string }>(sql`
    SELECT ST_DistanceSphere(
      ST_MakePoint(${attacker.lastLng}, ${attacker.lastLat}),
      ST_MakePoint(${defender.lastLng}, ${defender.lastLat})
    ) AS distance_m
  `);

  const rows = result.rows as { distance_m: string }[];
  const distanceM = parseFloat(rows[0]?.distance_m ?? "Infinity");

  if (distanceM > PVP_AGGRO_RADIUS_M) {
    // Defender escaped!
    await db
      .update(pvpChallenges)
      .set({ state: "ESCAPED" })
      .where(eq(pvpChallenges.id, challengeId));

    if (wsHub) {
      wsHub.sendToTeam(challenge.attackerTeamId, {
        event: "pvp:challenge_escaped",
        data: { challengeId },
      });
      wsHub.sendToTeam(challenge.defenderTeamId, {
        event: "pvp:challenge_escaped",
        data: { challengeId },
      });
    }
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

/**
 * Start PvP combat between two teams.
 */
async function startPvPCombat(opts: {
  attackerTeamId: string;
  defenderTeamId: string;
  wsHub?: WsHub;
}): Promise<CombatInstance> {
  const { attackerTeamId, defenderTeamId, wsHub } = opts;

  // Get both teams' players
  const attackerPlayers = await db
    .select()
    .from(players)
    .where(eq(players.teamId, attackerTeamId));

  const defenderPlayers = await db
    .select()
    .from(players)
    .where(eq(players.teamId, defenderTeamId));

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
      await db.insert(combatants).values({
        combatInstanceId: combat.id,
        entityType: "PLAYER",
        entityId: player.id,
        teamId: player.teamId,
        hpCurrent: Math.min(player.hpCurrent, hpMax),
      });
    }),
    ...defenderPlayers.map(async (player) => {
      const { hpMax } = await getPlayerStats(player);
      await db.insert(combatants).values({
        combatInstanceId: combat.id,
        entityType: "PLAYER",
        entityId: player.id,
        teamId: player.teamId,
        hpCurrent: Math.min(player.hpCurrent, hpMax),
      });
    }),
  ]);

  // Start round 1
  await db
    .update(combatInstances)
    .set({
      state: "AWAITING_ACTIONS",
      roundNumber: 1,
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
