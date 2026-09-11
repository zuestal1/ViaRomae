/**
 * Boss Combat Service (Epic 8)
 * World Boss mechanics: multi-team, scaled HP, global actions.
 */

import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  combatInstances,
  combatants,
  combatActions,
} from "../../db/schema/combat.js";
import { players, teams } from "../../db/schema/player.js";
import { worldObjects } from "../../db/schema/world.js";
import type { WsHub } from "../ws/ws.hub.js";
import { randomUUID } from "node:crypto";
import { getCombatInstance, lockAndResolveRound, type Combatant, type CombatInstance } from "./combat.service.js";
import { getPlayerStats } from "../player/player-stats.service.js";
import { requireActiveEvent } from "../gm/event-runtime.service.js";

// ── Constants ────────────────────────────────────────────────────────────────

const CANNONIERE_STATS = { hp: 2160, def: 24, initiative: 9 } as const;
const NERO_STATS = { hp: 3240, def: 30, initiative: 11 } as const;
const BOSS_ROUND_TIMER_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface BossGlobalAction {
  teamId: string;
    actionType: "APPLAUD";
  timestamp: Date;
}

// Global state for active boss instances (in-memory for now)
const activeBossInstances = new Map<string, {
  combatId: string;
  worldObjectId: string;
  participatingTeams: Set<string>;
  globalActions: BossGlobalAction[];
}>();

// ── Boss Combat Management ───────────────────────────────────────────────────

/**
 * Get or create a global boss combat instance for a world object.
 * Unlike PvE, boss instances are shared across all teams.
 */
export async function getOrCreateBossCombat(opts: {
  worldObjectId: string;
  wsHub?: WsHub;
}): Promise<CombatInstance> {
  await requireActiveEvent();
  const { worldObjectId, wsHub } = opts;

  // Check if there's already an active boss combat for this world object
  const existingBoss = activeBossInstances.get(worldObjectId);
  if (existingBoss) {
    const loaded = await getCombatInstance(existingBoss.combatId);
    if (loaded.state !== "COMPLETED") return loaded;
    activeBossInstances.delete(worldObjectId);
  }
  const persisted = await db.execute<{ combat_id: string; team_id: string | null }>(sql`
    SELECT ci.id combat_id,c.team_id FROM combat_instance ci JOIN combatant c ON c.combat_instance_id=ci.id
    WHERE ci.type='BOSS' AND ci.state<>'COMPLETED' AND EXISTS (SELECT 1 FROM combatant boss
      WHERE boss.combat_instance_id=ci.id AND boss.entity_type='ENEMY' AND boss.entity_id=${worldObjectId}::uuid)`);
  if (persisted.rows[0]) {
    activeBossInstances.set(worldObjectId, { combatId: persisted.rows[0].combat_id, worldObjectId,
      participatingTeams: new Set(persisted.rows.flatMap((row) => row.team_id ? [row.team_id] : [])), globalActions: [] });
    return getCombatInstance(persisted.rows[0].combat_id);
  }

  // Get boss data
  const [boss] = await db
    .select()
    .from(worldObjects)
    .where(eq(worldObjects.id, worldObjectId));

  if (!boss || boss.type !== "BOSS") {
    throw new Error("Invalid boss encounter");
  }

  // Create global boss combat instance
  const combatResults = await db
    .insert(combatInstances)
    .values({
      type: "BOSS",
      state: "AWAITING_ACTIONS",
      roundNumber: 1,
      roundStartedAt: new Date(),
      actionDeadline: new Date(Date.now() + BOSS_ROUND_TIMER_MS),
    })
    .returning();

  const combat = combatResults[0];
  if (!combat) {
    throw new Error("Failed to create boss combat instance");
  }

  // Start with base HP (will scale as teams join)
  const configured = boss.name.toLowerCase().includes("nero") ? NERO_STATS : CANNONIERE_STATS;
  const bossProps = boss.rawPropertiesJson ? JSON.parse(boss.rawPropertiesJson) : {};
  const bossHp = Number(bossProps.hp ?? configured.hp);
  // Create boss combatant (ENEMY type)
  await db.insert(combatants).values({
    combatInstanceId: combat.id,
    entityType: "ENEMY",
    entityId: worldObjectId,
    hpCurrent: bossHp,
  });

  // Register in global state
  activeBossInstances.set(worldObjectId, {
    combatId: combat.id,
    worldObjectId,
    participatingTeams: new Set(),
    globalActions: [],
  });
  setTimeout(() => void lockAndResolveRound(combat.id, wsHub).catch(() => undefined), BOSS_ROUND_TIMER_MS);

  // Transition to AWAITING_ACTIONS
  await db
    .update(combatInstances)
    .set({ state: "AWAITING_ACTIONS" })
    .where(eq(combatInstances.id, combat.id));

  // Emit global event (visible to all teams in range)
  if (wsHub) {
    // Note: Boss events use sendToTeam for now; global broadcast requires extending WsHub
    // wsHub.sendToTeam("global", { ... }) - Epic 9 feature
  }

  return await loadCombatInstance(combat.id);
}

/**
 * Add a team to an active boss combat.
 * Scales boss HP based on number of teams.
 */
export async function joinBossCombat(opts: {
  combatId: string;
  teamId: string;
  wsHub?: WsHub;
}): Promise<void> {
  const { combatId, teamId, wsHub } = opts;

  // Get combat instance
  const combat = await loadCombatInstance(combatId);
  if (combat.type !== "BOSS") {
    throw new Error("Not a boss combat");
  }

  if (combat.state === "COMPLETED") {
    throw new Error("Boss already defeated");
  }

  // Check if team is already participating
  const worldObjectId = combat.combatants.find((c) => c.entityType === "ENEMY")?.entityId;
  if (!worldObjectId) {
    throw new Error("Boss combatant not found");
  }

  const bossState = activeBossInstances.get(worldObjectId);
  if (!bossState) {
    throw new Error("Boss state not found");
  }

  if (bossState.participatingTeams.has(teamId)) {
    throw new Error("Team already in boss combat");
  }

  // Get team players
  const teamPlayers = await db
    .select()
    .from(players)
    .where(eq(players.teamId, teamId));

  if (teamPlayers.length === 0) {
    throw new Error("Team has no players");
  }

  // Add player combatants
  for (const player of teamPlayers) {
    const { hpMax } = await getPlayerStats(player);
    await db.insert(combatants).values({
      combatInstanceId: combatId,
      entityType: "PLAYER",
      entityId: player.id,
      teamId: player.teamId,
      hpCurrent: Math.min(player.hpCurrent, hpMax),
    });
  }

  // GDD 26.4 deliberately leaves dynamic HP scaling open. Preserve the
  // configured start HP so late participation never heals the boss.
  
  const bossCombatant = combat.combatants.find((c) => c.entityType === "ENEMY");
  if (bossCombatant) {
    // no dynamic scaling
  }

  // Update state
  bossState.participatingTeams.add(teamId);

  // Emit event
  if (wsHub) {
    // Emit to all participating teams
    for (const participatingTeamId of bossState.participatingTeams) {
      wsHub.sendToTeam(participatingTeamId, {
        event: "boss:team_joined",
        data: {
          combatId,
          teamId,
          teamCount: bossState.participatingTeams.size,
        },
      });
    }

    // Update all teams with new boss HP
    // Emit to all participating teams
    for (const participatingTeamId of bossState.participatingTeams) {
      wsHub.sendToTeam(participatingTeamId, {
        event: "boss:health_updated",
        data: {
          combatId,
          hpCurrent: bossCombatant?.hpCurrent ?? 0,
          hpMax: bossCombatant?.hpMax ?? 0,
          percentRemaining: bossCombatant?.hpMax ? bossCombatant.hpCurrent / bossCombatant.hpMax * 100 : 0,
        },
      });
    }
  }
}

/**
 * Submit a global boss action (e.g., APPLAUD).
 * These are team-wide actions that affect the entire boss fight.
 */
export async function submitGlobalAction(opts: {
  combatId: string;
  teamId: string;
  actionType: "APPLAUD";
  playerId: string;
  requestId: string;
  wsHub?: WsHub;
}): Promise<void> {
  const { combatId, teamId, actionType, playerId, requestId, wsHub } = opts;

  // Get combat instance
  const combat = await loadCombatInstance(combatId);
  if (combat.type !== "BOSS") {
    throw new Error("Not a boss combat");
  }

  // Find boss state
  const worldObjectId = combat.combatants.find((c) => c.entityType === "ENEMY")?.entityId;
  if (!worldObjectId) {
    throw new Error("Boss combatant not found");
  }

  const bossState = activeBossInstances.get(worldObjectId);
  if (!bossState) {
    throw new Error("Boss state not found");
  }

  const accepted = await db.execute(sql`INSERT INTO boss_mechanic_response(request_id,combat_id,team_id,player_id,action_type)
    VALUES (${requestId}::uuid,${combatId}::uuid,${teamId}::uuid,${playerId}::uuid,${actionType})
    ON CONFLICT DO NOTHING RETURNING request_id`);
  if (!accepted.rows.length) return;
  // Record global action
  bossState.globalActions.push({
    teamId,
    actionType,
    timestamp: new Date(),
  });

  // Apply effect based on action type
  let effect = "";
  switch (actionType) {
    case "APPLAUD":
      // GDD 26.8 fixes the response, but explicitly leaves quota and effects open.
      effect = "Applaus bestätigt.";
      break;
  }

  // Emit event
  if (wsHub) {
    // Find boss state to emit to all teams
    const worldObjectId = combat.combatants.find((c) => c.entityType === "ENEMY")?.entityId;
    if (worldObjectId) {
      const bossState = activeBossInstances.get(worldObjectId);
      if (bossState) {
        for (const participatingTeamId of bossState.participatingTeams) {
          wsHub.sendToTeam(participatingTeamId, {
            event: "boss:global_action",
            data: {
              combatId,
              teamId,
              actionType,
              effect,
            },
          });
        }
      }
    }
  }
}

/**
 * Clean up boss state when combat completes.
 */
export async function completeBossCombat(opts: {
  combatId: string;
  wsHub?: WsHub;
}): Promise<void> {
  const { combatId, wsHub } = opts;

  // Find and remove from active instances
  for (const [worldObjectId, state] of activeBossInstances.entries()) {
    if (state.combatId === combatId) {
      const combat = await loadCombatInstance(combatId);
      const boss = combat.combatants.find((c) => c.entityType === "ENEMY");

      // Emit completion event to all participating teams
      if (wsHub && boss) {
        for (const participatingTeamId of state.participatingTeams) {
          wsHub.sendToTeam(participatingTeamId, {
            event: "boss:defeated",
            data: {
              combatId,
              bossName: boss.name,
              participatingTeams: Array.from(state.participatingTeams),
            },
          });
        }
      }

      activeBossInstances.delete(worldObjectId);
      break;
    }
  }
}

/**
 * Get boss combat status for a world object.
 */
export async function getBossCombatStatus(worldObjectId: string): Promise<{
  active: boolean;
  combatId?: string;
  participatingTeams?: number;
  bossHpPercent?: number;
} | null> {
  const bossState = activeBossInstances.get(worldObjectId);
  if (!bossState) {
    const persisted = await db.execute<{ id: string }>(sql`SELECT ci.id FROM combat_instance ci
      WHERE ci.type='BOSS' AND ci.state<>'COMPLETED' AND EXISTS (SELECT 1 FROM combatant c
        WHERE c.combat_instance_id=ci.id AND c.entity_type='ENEMY' AND c.entity_id=${worldObjectId}::uuid) LIMIT 1`);
    if (!persisted.rows[0]) return { active: false };
    const teams = await db.execute<{ team_id: string }>(sql`SELECT DISTINCT team_id FROM combatant
      WHERE combat_instance_id=${persisted.rows[0].id}::uuid AND team_id IS NOT NULL`);
    activeBossInstances.set(worldObjectId, { combatId: persisted.rows[0].id, worldObjectId,
      participatingTeams: new Set(teams.rows.map((row) => row.team_id)), globalActions: [] });
    return getBossCombatStatus(worldObjectId);
  }

  const combat = await loadCombatInstance(bossState.combatId);
  const bossCombatant = combat.combatants.find((c) => c.entityType === "ENEMY");
  
  return {
    active: true,
    combatId: bossState.combatId,
    participatingTeams: bossState.participatingTeams.size,
    bossHpPercent: bossCombatant
      ? (bossCombatant.hpCurrent / bossCombatant.hpMax) * 100
      : 100,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadCombatInstance(combatId: string): Promise<CombatInstance> {
  const [combat] = await db
    .select()
    .from(combatInstances)
    .where(eq(combatInstances.id, combatId));

  if (!combat) {
    throw new Error("Combat instance not found");
  }

  const combatantRows = await db
    .select()
    .from(combatants)
    .where(eq(combatants.combatInstanceId, combatId));

  const actionRows = await db
    .select()
    .from(combatActions)
    .where(eq(combatActions.combatInstanceId, combatId));

  // Enrich combatants with names
  const enrichedCombatants: Combatant[] = await Promise.all(
    combatantRows.map(async (c) => {
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
        if (player) {
          const accountResult = await db.execute<{ username: string }>(
            sql`SELECT username FROM account WHERE id = ${player.accountId}`,
          );
          const account = (accountResult.rows as { username: string }[])[0];
          name = account?.username ?? "Player";
          const stats = await getPlayerStats(player);
          ({ hpMax, atk, def, initiative } = stats);
        }
      } else {
        const [enemy] = await db
          .select()
          .from(worldObjects)
          .where(eq(worldObjects.id, c.entityId));
        if (enemy) {
          name = enemy.name;
          const props = enemy.rawPropertiesJson
            ? JSON.parse(enemy.rawPropertiesJson)
            : {};
          const configured = enemy.name.toLowerCase().includes("nero") ? NERO_STATS : CANNONIERE_STATS;
          hpMax = props.hp ?? configured.hp;
          atk = props.atk ?? props.attack ?? 10;
          def = props.def ?? props.defense ?? configured.def;
          initiative = props.initiative ?? configured.initiative;
        }
      }

      return {
        id: c.id,
        entityType: c.entityType,
        entityId: c.entityId,
        teamId: c.teamId ?? undefined,
        hpCurrent: Math.min(c.hpCurrent, hpMax),
        hpMax,
        atk,
        def,
        initiative,
        stats: { attack: atk, defense: def, initiative },
        equipmentRarityScore: 0,
        shield: 0,
        name,
        isDowned: c.hpCurrent <= 0,
        activeEffects: [],
        statusEffects: [],
        cooldowns: [],
      };
    }),
  );

  return {
    id: combat.id,
    type: combat.type,
    state: combat.state,
    roundNumber: combat.roundNumber,
    startedAt: combat.startedAt,
    combatants: enrichedCombatants,
    threat: [],
    actions: actionRows.map((a) => ({
      id: a.id,
      roundNumber: a.roundNumber,
      actorId: a.actorId,
      actionType: (a.actionType === "SKILL" ? "SKILL" : "ATTACK") as "ATTACK" | "SKILL",
      targetId: a.targetId ?? undefined,
      isLocked: a.isLocked,
      origin: a.origin,
    })),
  };
}
