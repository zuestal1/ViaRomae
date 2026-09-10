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
import type { Combatant, CombatInstance } from "./combat.service.js";
import { getPlayerStats } from "../player/player-stats.service.js";

// ── Constants ────────────────────────────────────────────────────────────────

const BOSS_HP_BASE = 500; // Base HP for boss
const BOSS_HP_SCALE_PER_TEAM = 300; // Additional HP per participating team
const BOSS_ROUND_TIMER_MS = 20_000; // 20 seconds per round for boss fights

// ── Types ────────────────────────────────────────────────────────────────────

interface BossGlobalAction {
  teamId: string;
  actionType: "APPLAUD" | "CHEER" | "COORDINATED_ATTACK";
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
  const { worldObjectId, wsHub } = opts;

  // Check if there's already an active boss combat for this world object
  const existingBoss = activeBossInstances.get(worldObjectId);
  if (existingBoss) {
    return await loadCombatInstance(existingBoss.combatId);
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
      roundNumber: 0,
    })
    .returning();

  const combat = combatResults[0];
  if (!combat) {
    throw new Error("Failed to create boss combat instance");
  }

  // Start with base HP (will scale as teams join)
  const bossHp = BOSS_HP_BASE;
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

  // Scale boss HP
  const newTeamCount = bossState.participatingTeams.size + 1;
  const scaledBossHp = BOSS_HP_BASE + (newTeamCount - 1) * BOSS_HP_SCALE_PER_TEAM;
  
  const bossCombatant = combat.combatants.find((c) => c.entityType === "ENEMY");
  if (bossCombatant) {
    // Scale current HP proportionally
    const hpRatio = bossCombatant.hpCurrent / bossCombatant.hpMax;
    const newHpCurrent = Math.floor(scaledBossHp * hpRatio);
    
    await db
      .update(combatants)
      .set({ hpCurrent: newHpCurrent })
      .where(eq(combatants.id, bossCombatant.id));
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
          hpCurrent: bossCombatant?.hpCurrent ?? scaledBossHp,
          hpMax: scaledBossHp,
          percentRemaining: ((bossCombatant?.hpCurrent ?? scaledBossHp) / scaledBossHp) * 100,
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
  actionType: "APPLAUD" | "CHEER" | "COORDINATED_ATTACK";
  wsHub?: WsHub;
}): Promise<void> {
  const { combatId, teamId, actionType, wsHub } = opts;

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
      // Buff all teams: +10% damage for next round
      effect = "All teams gain +10% damage for the next round!";
      break;
    case "CHEER":
      // Heal all players by 5 HP
      effect = "All players healed by 5 HP!";
      for (const combatant of combat.combatants.filter((entry) => entry.entityType === "PLAYER")) {
        await db.update(combatants)
          .set({ hpCurrent: Math.min(combatant.hpMax, combatant.hpCurrent + 5) })
          .where(eq(combatants.id, combatant.id));
      }
      break;
    case "COORDINATED_ATTACK":
      // All teams deal bonus damage this round
      effect = "Coordinated attack! All teams deal +20 bonus damage!";
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
    return { active: false };
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
          hpMax = props.hp ?? BOSS_HP_BASE;
          atk = props.atk ?? props.attack ?? 10;
          def = props.def ?? props.defense ?? 0;
          initiative = props.initiative ?? 0;
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
        name,
        isDowned: c.hpCurrent <= 0,
        activeEffects: [],
        shield: 0,
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
    actions: actionRows.map((a) => ({
      id: a.id,
      roundNumber: a.roundNumber,
      actorId: a.actorId,
      actionType: a.actionType,
      targetId: a.targetId ?? undefined,
      isLocked: a.isLocked,
      origin: a.origin,
    })),
  };
}
