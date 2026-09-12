/**
 * GM Dashboard Service – Epic 9
 * Provides live data for GM dashboard: player positions, team status, world objects.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../../db/client.js";
import { players, teams } from "../../db/schema/player.js";
import { worldObjects } from "../../db/schema/world.js";
import { ledgerEntries } from "../../db/schema/economy_v2.js";
import { objectiveProgress, questDefinitions, questRuns, questSteps } from "../../db/schema/quest.js";
import { accounts } from "../../db/schema/account.js";
import { eq, and, sql } from "drizzle-orm";
import type {
  PlayerPosition,
  TeamStatus,
  WorldObjectMarker,
} from "@jlw/contracts";

export class GMDashboardService {
  private logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger.child({ module: "GMDashboardService" });
  }

  /**
   * Get all player positions for live map.
   * Only returns players with valid coordinates (lastLat/lastLng not null).
   */
  async getAllPlayerPositions(): Promise<PlayerPosition[]> {
    const result = await db
      .select({
        playerId: players.id,
        teamId: players.teamId,
        teamName: teams.name,
        lastLat: players.lastLat,
        lastLng: players.lastLng,
        lastLocationUpdate: players.lastLocationUpdate,
        accountId: players.accountId,
      })
      .from(players)
      .innerJoin(teams, eq(teams.id, players.teamId))
      .where(
        and(
          sql`${players.lastLat} IS NOT NULL`,
          sql`${players.lastLng} IS NOT NULL`,
        ),
      );

    // Get player names from accounts
    const accountIds = result.map((r) => r.accountId);
    const accountRows = await db
      .select({
        id: accounts.id,
        username: accounts.username,
      })
      .from(accounts)
      .where(sql`${accounts.id} IN (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})`);

    const accountMap = new Map(accountRows.map((a) => [a.id, a.username]));

    return result
      .filter((r) => r.lastLat !== null && r.lastLng !== null)
      .map((r) => ({
        playerId: r.playerId,
        playerName: accountMap.get(r.accountId) ?? "Unknown",
        teamId: r.teamId,
        teamName: r.teamName,
        lat: r.lastLat!,
        lng: r.lastLng!,
        accuracy: 15, // Default accuracy for display
        lastUpdate: r.lastLocationUpdate?.toISOString() ?? new Date().toISOString(),
      }));
  }

  /**
   * Get all team status data for dashboard overview.
   */
  async getAllTeamStatus(): Promise<TeamStatus[]> {
    const allTeams = await db.select().from(teams);

    const result: TeamStatus[] = [];

    for (const team of allTeams) {
      // Get FAME balance
      const fameResult = await db
        .select({
          total: sql<number>`COALESCE(SUM(${ledgerEntries.amount}), 0)`,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.teamId, team.id),
            eq(ledgerEntries.currencyType, "FAME"),
          ),
        );

      // Get DENARII balance
      const denariiResult = await db
        .select({
          total: sql<number>`COALESCE(SUM(${ledgerEntries.amount}), 0)`,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.teamId, team.id),
            eq(ledgerEntries.currencyType, "DENARII"),
          ),
        );

      const activeRuns = await db.select({ run: questRuns, definition: questDefinitions })
        .from(questRuns)
        .innerJoin(questDefinitions, eq(questDefinitions.id, questRuns.questDefinitionId))
        .where(
          and(
            eq(questRuns.teamId, team.id),
            eq(questRuns.state, "ACTIVE"),
          ),
        );
      const activeQuests = [];
      for (const { run, definition } of activeRuns) {
        const rows = await db.select({ step: questSteps, progress: objectiveProgress })
          .from(questSteps).leftJoin(objectiveProgress, and(eq(objectiveProgress.questRunId, run.id), eq(objectiveProgress.objectiveId, questSteps.stepId)))
          .where(and(eq(questSteps.questDefinitionId, run.questDefinitionId), eq(questSteps.stepCategory, "OBJECTIVE"), eq(questSteps.required, true)))
          .orderBy(questSteps.sequence);
        const current = rows.find(({ progress }) => !progress || !["COMPLETED", "SKIPPED"].includes(progress.status));
        if (current) {
          const content = current.step.authoredContent as { description?: string; text?: string };
          activeQuests.push({ questRunId: run.id, questTitle: definition.title, stepId: current.step.stepId,
            sequence: current.step.sequence, description: content.description ?? content.text ?? current.step.targetRef });
        }
      }

      result.push({
        teamId: team.id,
        teamName: team.name,
        hp: team.hp,
        fame: Number(fameResult[0]?.total ?? 0),
        denarii: Number(denariiResult[0]?.total ?? 0),
        activeQuestCount: activeQuests.length,
        activeQuests,
        isActive: team.isActive === 1,
      });
    }

    return result;
  }

  /**
   * Get all publishable world objects for map overlay.
   */
  async getAllWorldObjects(): Promise<WorldObjectMarker[]> {
    const objects = await db
      .select({
        id: worldObjects.id,
        externalId: worldObjects.externalId,
        type: worldObjects.type,
        name: worldObjects.name,
        lat: worldObjects.lat,
        lng: worldObjects.lng,
        cluster: worldObjects.cluster,
        discoveryRadiusM: worldObjects.discoveryRadiusM,
        interactionRadiusM: worldObjects.interactionRadiusM,
        publishable: worldObjects.publishable,
      })
      .from(worldObjects)
      .where(
        and(
          sql`${worldObjects.lat} IS NOT NULL`,
          sql`${worldObjects.lng} IS NOT NULL`,
        ),
      );

    return objects
      .filter((o) => o.lat !== null && o.lng !== null)
      .map((o) => ({
        id: o.id,
        externalId: o.externalId,
        type: o.type,
        name: o.name,
        lat: o.lat!,
        lng: o.lng!,
        cluster: o.cluster,
        discoveryRadiusM: o.discoveryRadiusM,
        interactionRadiusM: o.interactionRadiusM,
        publishable: o.publishable,
      }));
  }

  /**
   * Get player position by playerId.
   */
  async getPlayerPosition(playerId: string): Promise<PlayerPosition | null> {
    const result = await db
      .select({
        playerId: players.id,
        teamId: players.teamId,
        teamName: teams.name,
        lastLat: players.lastLat,
        lastLng: players.lastLng,
        lastLocationUpdate: players.lastLocationUpdate,
        accountId: players.accountId,
      })
      .from(players)
      .innerJoin(teams, eq(teams.id, players.teamId))
      .where(eq(players.id, playerId))
      .limit(1);

    if (result.length === 0 || !result[0]?.lastLat || !result[0]?.lastLng) {
      return null;
    }

    const [player] = result;

    // Get player name
    const [account] = await db
      .select({ username: accounts.username })
      .from(accounts)
      .where(eq(accounts.id, player.accountId))
      .limit(1);

    // Skip players without location data
    if (player.lastLat === null || player.lastLng === null) {
      return null;
    }

    return {
      playerId: player.playerId,
      playerName: account?.username ?? "Unknown",
      teamId: player.teamId,
      teamName: player.teamName,
      lat: player.lastLat,
      lng: player.lastLng,
      accuracy: 15,
      lastUpdate:
        player.lastLocationUpdate?.toISOString() ?? new Date().toISOString(),
    };
  }
}
