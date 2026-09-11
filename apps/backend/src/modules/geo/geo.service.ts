/**
 * Geo Service
 * ───────────
 * Handles player location updates and all PostGIS-based spatial logic for Epic 2.
 *
 * Public API:
 *   updatePlayerLocation()      – Persist coordinates; run spatial engine; emit WS events
 *   getNearbyWorldObjects()     – Return WorldObjects within discovery radius
 *   checkEffectiveDistance()    – One-off distance check (used by other modules)
 *
 * effectiveDistance formula (Epic 2 spec):
 *   effectiveDistance = max(0, ST_DistanceSphere(playerPoint, targetPoint) − min(accuracy, 10 m))
 *
 * GPS benefit-of-doubt is capped at 10 m: 30 m away with ±15 m accuracy has
 * an effective distance of 20 m and is outside a 15 m interaction radius.
 */

import { sql, eq, and, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { players } from "../../db/schema/player.js";
import { worldObjects, playAreas } from "../../db/schema/world.js";
import { playerProximityStates } from "../../db/schema/proximity.js";
import { questRuns, questSteps, objectiveProgress } from "../../db/schema/quest.js";
import {
  evaluateZones,
  computeExitTransitions,
  type SpatialWorldObject,
  type ProximityZone,
} from "./geo.spatial.js";
import type { WsHub } from "../ws/ws.hub.js";
import type {
  DistanceCheck,
  WorldObjectNearby,
  RadiusEvent,
  PlayArea,
} from "@jlw/contracts";
import { startPvECombat, getActiveCombatForTeam, checkRespawnArrival, checkPvPEscape } from "../combat/combat.service.js";
import { getOrCreateBossCombat, joinBossCombat } from "../combat/boss.service.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UpdateLocationResult {
  playerId: string;
  lat: number;
  lng: number;
  accuracy: number;
  updatedAt: string;
  /** Number of zone transitions that occurred (for logging / debugging). */
  transitionCount: number;
}

// Row shape returned by the PostGIS nearby query
interface NearbyRow extends Record<string, unknown> {
  id: string;
  external_id: string;
  type: string;
  name: string;
  lat: number;
  lng: number;
  cluster: string | null;
  discovery_radius_m: number;
  interaction_radius_m: number;
  exit_hysteresis_radius_m: number;
  aggro_radius_m: number;
  boss_join_radius_m: number;
  actual_distance_m: string; // PostGIS returns numeric as string
}

// ── Location update (main entry point) ───────────────────────────────────────

/**
 * Persist the player's GPS position, run the spatial engine against all
 * WorldObjects in the current day's PlayArea, and emit WS radius events
 * for any zone transitions.
 *
 * @param opts.wsHub  Optional WebSocket hub. When omitted (e.g. in tests),
 *                    transitions are computed but not emitted.
 *
 * @throws 404-shaped Error if no player record exists for this account (GM/ADMIN).
 */
export async function updatePlayerLocation(opts: {
  accountId: string;
  lat: number;
  lng: number;
  accuracy: number;
  wsHub?: WsHub;
}): Promise<UpdateLocationResult> {
  const { accountId, lat, lng, accuracy, wsHub } = opts;

  // ── 1. Resolve accountId → player (with team) ─────────────────────────────
  const [player] = await db
    .select({
      id: players.id,
      teamId: players.teamId,
      // Include account username for WS event playerName field
    })
    .from(players)
    .where(eq(players.accountId, accountId));

  if (!player) {
    const err = new Error(
      "No player record found for this account. GMs cannot update location.",
    ) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  // ── 2. Persist lat/lng + PostGIS geometry ─────────────────────────────────
  await db.execute(sql`
    UPDATE player
    SET
      last_lat = ${lat},
      last_lng = ${lng},
      last_accuracy = ${accuracy},
      geom     = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
      , last_location_update = now()
      , last_location_accuracy = ${accuracy}
      , valid_location_streak = CASE
          WHEN last_location_update >= now() - interval '15 seconds' THEN LEAST(valid_location_streak + 1, 2)
          ELSE 1
        END
    WHERE id = ${player.id}
  `);
  await checkRespawnArrival({ teamId: player.teamId, lat, lng, accuracy });
  await checkPvPEscape(player.teamId, wsHub);

  // ── 3. Query WorldObjects within discovery radius via PostGIS ─────────────
  const nearbyRows = await queryNearbyWorldObjects({ lat, lng, accuracy });

  // ── 4. Load current proximity states for this player ──────────────────────
  const stateRows = await db
    .select({
      worldObjectId: playerProximityStates.worldObjectId,
      zone: playerProximityStates.zone,
    })
    .from(playerProximityStates)
    .where(eq(playerProximityStates.playerId, player.id));

  const currentStates = new Map<string, ProximityZone>(
    stateRows.map((r) => [r.worldObjectId, r.zone as ProximityZone]),
  );

  // ── 5. Run state machine ───────────────────────────────────────────────────
  const nearbyAsSpatial = nearbyRows.map(
    (r): SpatialWorldObject & {
      actualDistanceM: number;
      effectiveDistanceM: number;
    } => ({
      id: r.id,
      externalId: r.external_id,
      type: r.type as SpatialWorldObject["type"],
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      cluster: r.cluster,
      discoveryRadiusM: r.discovery_radius_m,
      interactionRadiusM: r.interaction_radius_m,
      exitHysteresisRadiusM: r.exit_hysteresis_radius_m,
      aggroRadiusM: r.aggro_radius_m,
      actualDistanceM: parseFloat(r.actual_distance_m),
      effectiveDistanceM: Math.max(
        0,
        parseFloat(r.actual_distance_m) - Math.min(accuracy, 10),
      ),
    }),
  );

  const nearbyIds = new Set(nearbyRows.map((r) => r.id));
  const zoneResults = evaluateZones(nearbyAsSpatial, currentStates);
  const exitResults = computeExitTransitions(nearbyIds, currentStates);
  const allResults = [...zoneResults, ...exitResults];

  // ── 6. Persist state changes ───────────────────────────────────────────────
  const changed = allResults.filter((r) => r.changed);

  if (changed.length > 0) {
    // Upsert all changed states in one batch
    const upsertValues = changed.map((r) => ({
      playerId: player.id,
      worldObjectId: r.worldObjectId,
      zone: r.newZone,
    }));

    await db
      .insert(playerProximityStates)
      .values(upsertValues)
      .onConflictDoUpdate({
        target: [
          playerProximityStates.playerId,
          playerProximityStates.worldObjectId,
        ],
        set: {
          zone: sql`excluded.zone`,
          updatedAt: sql`now()`,
        },
      });
  }

  // ── 7. Emit WebSocket events for transitions ──────────────────────────────
  if (wsHub && changed.length > 0) {
    // Build a name lookup for changed objects
    const changedIds = changed
      .filter((r) => r.actualDistanceM !== Infinity)
      .map((r) => r.worldObjectId);

    let objectNames = new Map<string, { name: string; type: string }>();
    if (changedIds.length > 0) {
      const nameRows = await db
        .select({
          id: worldObjects.id,
          name: worldObjects.name,
          type: worldObjects.type,
        })
        .from(worldObjects)
        .where(inArray(worldObjects.id, changedIds));

      objectNames = new Map(nameRows.map((r) => [r.id, { name: r.name, type: r.type }]));
    }

    // Also look up names for exit transitions (not in nearby query)
    const exitIds = exitResults.map((r) => r.worldObjectId);
    if (exitIds.length > 0) {
      const exitNameRows = await db
        .select({ id: worldObjects.id, name: worldObjects.name, type: worldObjects.type })
        .from(worldObjects)
        .where(inArray(worldObjects.id, exitIds));
      for (const r of exitNameRows) {
        objectNames.set(r.id, { name: r.name, type: r.type });
      }
    }

    // Retrieve player username for the event
    const [accountRow] = await db.execute<{ username: string }>(
      sql`SELECT username FROM account WHERE id = ${accountId}`,
    ).then((r) => r.rows as { username: string }[]);

    const playerName = accountRow?.username ?? "Unknown";
    const now = new Date().toISOString();

    for (const transition of changed) {
      const obj = objectNames.get(transition.worldObjectId);
      if (!obj) continue;

      const event: RadiusEvent = {
        event: "radius.transition",
        playerId: player.id,
        playerName,
        teamId: player.teamId,
        worldObjectId: transition.worldObjectId,
        worldObjectName: obj.name,
        worldObjectType: obj.type as RadiusEvent["worldObjectType"],
        previousZone: transition.previousZone,
        newZone: transition.newZone,
        effectiveDistanceM:
          transition.effectiveDistanceM === Infinity
            ? -1
            : transition.effectiveDistanceM,
        timestamp: now,
      };

      // BOSS_JOIN events are broadcast to all clients (global boss mechanic)
      if (
        transition.newZone === "BOSS_JOIN" ||
        transition.previousZone === "BOSS_JOIN"
      ) {
        wsHub.broadcastAll(event);
      } else {
        wsHub.broadcastToTeam(player.teamId, event);
      }
    }
  }

  // ── 8. Check for PvE encounter trigger (Epic 6) ───────────────────────────
  // If a team enters AGGRO radius of an ENEMY and has an active DEFEAT_ENEMY quest step,
  // start a combat instance.
  if (changed.length > 0) {
    if (wsHub) {
      await checkPvEEncounterTrigger({
        playerId: player.id,
        teamId: player.teamId,
        transitions: changed,
        nearbyObjects: nearbyAsSpatial,
        wsHub,
      });

      // Check for BOSS_JOIN transitions and auto-join boss combat (Epic 8)
      await checkBossJoinTrigger({
        playerId: player.id,
        teamId: player.teamId,
        transitions: changed,
        nearbyObjects: nearbyAsSpatial,
        wsHub,
      });
    } else {
      await checkPvEEncounterTrigger({
        playerId: player.id,
        teamId: player.teamId,
        transitions: changed,
        nearbyObjects: nearbyAsSpatial,
      });

      // Check for BOSS_JOIN transitions (no WebSocket)
      await checkBossJoinTrigger({
        playerId: player.id,
        teamId: player.teamId,
        transitions: changed,
        nearbyObjects: nearbyAsSpatial,
      });
    }
  }

  return {
    playerId: player.id,
    lat,
    lng,
    accuracy,
    updatedAt: new Date().toISOString(),
    transitionCount: changed.length,
  };
}

// ── Nearby WorldObjects query ─────────────────────────────────────────────────

/**
 * Return all WorldObjects whose `geom` is within the player's discovery radius
 * (default 55 m) using PostGIS `ST_DWithin` on the geography cast for
 * accurate metre-based distance on WGS-84.
 *
 * We query up to `discovery_radius_m` + `min(accuracy, 10 m)` so objects at the
 * boundary aren't missed due to GPS imprecision.
 *
 * PostGIS note:
 *   ST_DWithin(geography, geography, metres) is faster than ST_DistanceSphere
 *   because it short-circuits once the bbox check passes.
 */
async function queryNearbyWorldObjects(opts: {
  lat: number;
  lng: number;
  accuracy: number;
}): Promise<NearbyRow[]> {
  const { lat, lng, accuracy } = opts;

  // Expand the search radius by the GDD-capped GPS accuracy credit so objects
  // at the boundary are not missed without over-crediting imprecise fixes.
  const accuracyBuffer = Math.ceil(Math.min(accuracy, 10));

  // In development/playtest mode, also include non-publishable objects so that
  // prototype content (which ships with publishable=false) is discoverable
  // without a production content approval cycle.
  const skipPublishableFilter =
    process.env["NODE_ENV"] !== "production" &&
    (process.env["SEED_SKIP_FILTER"] === "true" ||
      process.env["PLAYTEST_MODE"] === "true");

  const result = await db.execute<NearbyRow>(sql`
    SELECT
      wo.id,
      wo.external_id,
      wo.type,
      wo.name,
      wo.lat,
      wo.lng,
      wo.cluster,
      wo.discovery_radius_m,
      wo.interaction_radius_m,
      wo.exit_hysteresis_radius_m,
      wo.aggro_radius_m,
      wo.boss_join_radius_m,
      ST_DistanceSphere(
        wo.geom,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
      ) AS actual_distance_m
    FROM world_object wo
    WHERE
      wo.geom IS NOT NULL
      AND (${skipPublishableFilter} OR wo.publishable = true)
      AND ST_DWithin(
        wo.geom::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        wo.discovery_radius_m + ${accuracyBuffer}
      )
    ORDER BY actual_distance_m ASC
  `);

  return result.rows as NearbyRow[];
}

// ── Public: getNearbyWorldObjects ─────────────────────────────────────────────

/**
 * Return nearby WorldObjects enriched with the current player zone.
 * Used by GET /api/v1/geo/world-objects.
 *
 * @throws 404 if no player record exists for this account.
 */
export async function getNearbyWorldObjects(opts: {
  accountId: string;
  accuracy: number;
  /** Optional: use these coordinates directly instead of the DB-stored position. */
  overrideLat?: number;
  overrideLng?: number;
}): Promise<{
  objects: WorldObjectNearby[];
  playerLat: number;
  playerLng: number;
}> {
  const { accountId, accuracy, overrideLat, overrideLng } = opts;

  // Load player (need lat/lng + teamId)
  const [player] = await db
    .select({
      id: players.id,
      teamId: players.teamId,
      lastLat: players.lastLat,
      lastLng: players.lastLng,
    })
    .from(players)
    .where(eq(players.accountId, accountId));

  if (!player) {
    const err = new Error(
      "No player record found for this account.",
    ) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  if (player.lastLat == null || player.lastLng == null) {
    // Player hasn't sent a location yet.
    // If the client supplied live coords, use those; otherwise return empty.
    if (overrideLat != null && overrideLng != null) {
      return { objects: [], playerLat: overrideLat, playerLng: overrideLng };
    }
    return { objects: [], playerLat: 0, playerLng: 0 };
  }

  // Prefer live coords supplied by the client (avoids race condition between
  // POST /location and GET /world-objects when GPS position changes).
  const queryLat = overrideLat ?? player.lastLat;
  const queryLng = overrideLng ?? player.lastLng;

  const nearby = await queryNearbyWorldObjects({
    lat: queryLat,
    lng: queryLng,
    accuracy,
  });

  // Load current proximity states
  const stateRows = await db
    .select({
      worldObjectId: playerProximityStates.worldObjectId,
      zone: playerProximityStates.zone,
    })
    .from(playerProximityStates)
    .where(eq(playerProximityStates.playerId, player.id));

  const currentStates = new Map<string, ProximityZone>(
    stateRows.map((r) => [r.worldObjectId, r.zone as ProximityZone]),
  );

  const objects: WorldObjectNearby[] = nearby.map((r) => {
    const actualDist = parseFloat(r.actual_distance_m);
    const effectiveDist = Math.max(0, actualDist - Math.min(accuracy, 10));
    const zone = currentStates.get(r.id) ?? "OUTSIDE";

    return {
      id: r.id,
      externalId: r.external_id,
      type: r.type as WorldObjectNearby["type"],
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      cluster: r.cluster,
      discoveryRadiusM: r.discovery_radius_m,
      interactionRadiusM: r.interaction_radius_m,
      exitHysteresisRadiusM: r.exit_hysteresis_radius_m,
      aggroRadiusM: r.aggro_radius_m,
      zone,
      effectiveDistanceM: effectiveDist,
    };
  });

  return {
    objects,
    playerLat: queryLat,
    playerLng: queryLng,
  };
}

// ── PostGIS distance validation ───────────────────────────────────────────────

/**
 * Calculate the distance between two WGS-84 points using PostGIS
 * `ST_DistanceSphere`, then apply the accuracy-tolerance formula.
 *
 * PostGIS note: ST_MakePoint expects (longitude, latitude) order.
 *
 * @param playerLat  Player's latitude (degrees)
 * @param playerLng  Player's longitude (degrees)
 * @param targetLat  Target object's latitude (degrees)
 * @param targetLng  Target object's longitude (degrees)
 * @param accuracy   Player's GPS horizontal accuracy (metres)
 * @param targetRadius  Interaction/discovery radius of the target object (metres)
 */
export async function checkEffectiveDistance(opts: {
  playerLat: number;
  playerLng: number;
  targetLat: number;
  targetLng: number;
  accuracy: number;
  targetRadius: number;
}): Promise<DistanceCheck> {
  const { playerLat, playerLng, targetLat, targetLng, accuracy, targetRadius } =
    opts;

  const result = await db.execute<{ distance_m: string }>(sql`
    SELECT ST_DistanceSphere(
      ST_MakePoint(${playerLng}, ${playerLat}),
      ST_MakePoint(${targetLng}, ${targetLat})
    ) AS distance_m
  `);

  const rows = result.rows as { distance_m: string }[];
  const actualDistanceM = parseFloat(rows[0]?.distance_m ?? "Infinity");
  const effectiveDistanceM = Math.max(0, actualDistanceM - Math.min(accuracy, 10));
  const withinRange = effectiveDistanceM <= targetRadius;

  return { actualDistanceM, effectiveDistanceM, withinRange };
}

// ── PvE Encounter Trigger (Epic 6) ────────────────────────────────────────────

/**
 * Check if any zone transition triggers a PvE combat encounter.
 * Called after location update when a player enters an enemy aggro radius.
 */
async function checkPvEEncounterTrigger(opts: {
  playerId: string;
  teamId: string;
  transitions: Array<{
    worldObjectId: string;
    newZone: ProximityZone;
    previousZone: ProximityZone;
  }>;
  nearbyObjects: Array<SpatialWorldObject & { actualDistanceM: number }>;
  wsHub?: WsHub;
}): Promise<void> {
  const { playerId, teamId, transitions, nearbyObjects, wsHub } = opts;

  // Check if team already in combat
  const existingCombat = await getActiveCombatForTeam(teamId);
  if (existingCombat) {
    return; // Already in combat, don't trigger another
  }

  // Find any AGGRO transitions for ENEMY objects
  const aggroTransitions = transitions.filter(
    (t) =>
      t.newZone === "AGGRO" &&
      (t.previousZone === "OUTSIDE" ||
        t.previousZone === "DISCOVERED" ||
        t.previousZone === "INTERACTING")
  );

  if (aggroTransitions.length === 0) {
    return;
  }

  // Check if team has an active DEFEAT_ENEMY quest step
  const activeQuests = await db
    .select({
      questRunId: questRuns.id,
      questDefId: questRuns.questDefinitionId,
    })
    .from(questRuns)
    .where(and(eq(questRuns.teamId, teamId), eq(questRuns.state, "ACTIVE")));

  if (activeQuests.length === 0) {
    return; // No active quests
  }

  // Check if any active quest has a DEFEAT_ENEMY step
  const pendingSteps = await db
    .select({
      questRunId: questRuns.id,
      stepId: questSteps.stepId,
      targetRef: questSteps.targetRef,
      sequence: questSteps.sequence,
      actionType: questSteps.stepActionType,
      progressStatus: objectiveProgress.status,
    })
    .from(questRuns)
    .innerJoin(questSteps, eq(questSteps.questDefinitionId, questRuns.questDefinitionId))
    .leftJoin(objectiveProgress, and(eq(objectiveProgress.questRunId, questRuns.id),
      eq(objectiveProgress.objectiveId, questSteps.stepId)))
    .where(
      and(
        inArray(questRuns.id, activeQuests.map((quest) => quest.questRunId)),
        eq(questSteps.flowPhase, "OBJECTIVE")
      )
    );
  const defeatEnemySteps = pendingSteps.filter((step) => {
    const firstPending = pendingSteps.filter((candidate) => candidate.questRunId === step.questRunId &&
      candidate.progressStatus !== "COMPLETED").sort((a, b) => a.sequence - b.sequence)[0];
    return firstPending?.stepId === step.stepId && step.actionType === "DEFEAT_ENEMY";
  });

  if (defeatEnemySteps.length === 0) {
    return; // No DEFEAT_ENEMY steps in active quests
  }

  // Match enemy encounter to quest step target_ref
  for (const transition of aggroTransitions) {
    const enemy = nearbyObjects.find((o) => o.id === transition.worldObjectId);
    if (!enemy || enemy.type !== "ENEMY") continue;

    // Check if this enemy matches any DEFEAT_ENEMY target_ref
    const matchingStep = defeatEnemySteps.find(
      (s) => s.targetRef === enemy.externalId
    );

    if (matchingStep) {
      try {
        // Start PvE combat!
        if (wsHub) {
          await startPvECombat({
            teamId,
            enemyWorldObjectId: enemy.id,
            wsHub,
          });
        } else {
          await startPvECombat({
            teamId,
            enemyWorldObjectId: enemy.id,
          });
        }

        // Combat started successfully, no need to check other transitions
        return;
      } catch (err) {
        // Log error but don't throw - location update should still succeed
        console.error(`Failed to start PvE combat for team ${teamId}:`, err);
      }
    }
  }
}

// ── Boss Join Trigger (Epic 8) ────────────────────────────────────────────────

/**
 * Check if a player entering BOSS_JOIN zone should auto-join a world boss combat.
 * Creates or joins a global boss instance.
 */
async function checkBossJoinTrigger(opts: {
  playerId: string;
  teamId: string;
  transitions: Array<{
    worldObjectId: string;
    newZone: ProximityZone;
    previousZone: ProximityZone;
  }>;
  nearbyObjects: Array<SpatialWorldObject & { actualDistanceM: number }>;
  wsHub?: WsHub;
}): Promise<void> {
  const { playerId, teamId, transitions, nearbyObjects, wsHub } = opts;

  // Find any BOSS_JOIN transitions for BOSS objects
  const bossJoinTransitions = transitions.filter(
    (t) =>
      t.newZone === "BOSS_JOIN" &&
      (t.previousZone === "OUTSIDE" ||
        t.previousZone === "DISCOVERED")
  );

  if (bossJoinTransitions.length === 0) {
    return;
  }

  // Process each boss join transition
  for (const transition of bossJoinTransitions) {
    const boss = nearbyObjects.find((o) => o.id === transition.worldObjectId);
    if (!boss || boss.type !== "BOSS") continue;

    try {
      // Get or create the global boss combat instance
      const combat = await getOrCreateBossCombat({
        worldObjectId: boss.id,
        ...(wsHub && { wsHub }),
      });

      // Join the team to the boss combat
      await joinBossCombat({
        combatId: combat.id,
        teamId,
        ...(wsHub && { wsHub }),
      });

      // Only join one boss at a time
      return;
    } catch (err) {
      // Log error but don't throw - location update should still succeed
      // Team might already be in the boss combat, which is fine
      console.error(`Failed to join boss combat for team ${teamId}:`, err);
    }
  }
}

// ── Play areas ─────────────────────────────────────────────────────────────────

/**
 * Return all play-area boundary polygons from the database.
 *
 * Each row's `geometry_geo_json` text is parsed to a plain object so the
 * response can be consumed directly by a MapLibre GeoJSON source on the
 * frontend.  Rows without a polygon are still returned (geojson: null) so
 * the client knows the day exists but has no drawn boundary yet.
 *
 * No auth guard required at the route level for Epic 3 – every authenticated
 * player needs the polygon to render the day-boundary overlay.
 */
export async function getPlayAreas(): Promise<PlayArea[]> {
  const rows = await db
    .select({
      id: playAreas.id,
      day: playAreas.day,
      name: playAreas.name,
      geometryGeoJson: playAreas.geometryGeoJson,
    })
    .from(playAreas)
    .orderBy(playAreas.day);

  return rows.map((row): PlayArea => {
    let geojson: PlayArea["geojson"] = null;

    if (row.geometryGeoJson) {
      try {
        const parsed = JSON.parse(row.geometryGeoJson) as unknown;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          "type" in parsed &&
          "coordinates" in parsed &&
          (parsed.type === "Polygon" || parsed.type === "MultiPolygon")
        ) {
          geojson = parsed as PlayArea["geojson"];
        }
      } catch {
        // Malformed JSON – return null to avoid crashing the client
      }
    }

    return {
      id: row.id,
      day: row.day,
      name: row.name ?? null,
      geojson,
    };
  });
}
