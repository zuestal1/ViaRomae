/**
 * Geo Spatial Engine – Three-Radius State Machine
 * ─────────────────────────────────────────────────
 * Implements the proximity-zone state machine described in Epic 2.
 *
 * Radii (from GeoJSON implementation_defaults, stored on world_object rows):
 *   discovery_radius_m          55 m  → map marker becomes visible
 *   interaction_radius_m        15 m  → NPC dialog / quest accept / puzzle trigger
 *   exit_hysteresis_radius_m    25 m  → interaction stays active until outside this
 *   enemy_aggro_radius_m        20 m  → PvE encounter trigger (ENEMY type)
 *   boss_join_radius_m          30 m  → global boss instance join (BOSS type)
 *
 * Anti-flicker (hysteresis):
 *   Once a player is INTERACTING or AGGRO they remain in that zone until
 *   effectiveDistance > exit_hysteresis_radius_m, preventing rapid
 *   zone oscillation at the border.
 *
 * effectiveDistance formula (gives player GPS benefit of doubt):
 *   effectiveDistance = max(0, ST_DistanceSphere(player, target) − min(accuracy, 10 m))
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProximityZone =
  | "OUTSIDE"
  | "DISCOVERED"
  | "INTERACTING"
  | "AGGRO"
  | "BOSS_JOIN";

/** Subset of world_object columns needed by the state machine. */
export interface SpatialWorldObject {
  id: string;
  externalId: string;
  type: "LOCATION" | "ENEMY" | "NPC" | "STORE" | "BOSS" | "SAFE_ZONE";
  name: string;
  lat: number;
  lng: number;
  discoveryRadiusM: number;
  interactionRadiusM: number;
  exitHysteresisRadiusM: number;
  aggroRadiusM: number;
  cluster: string | null;
}

/** Result of a single zone evaluation including the distance used. */
export interface ZoneResult {
  worldObjectId: string;
  previousZone: ProximityZone;
  newZone: ProximityZone;
  effectiveDistanceM: number;
  actualDistanceM: number;
  changed: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Boss join radius (metres) – sourced from GeoJSON implementation_defaults.
 * Not stored per-object since every boss uses the same threshold.
 */
export const BOSS_JOIN_RADIUS_M = 30;

// ── Core state-machine function ───────────────────────────────────────────────

/**
 * Determine the new proximity zone for a player relative to one WorldObject.
 *
 * Transition table:
 *
 *  BOSS type:
 *    effectiveDist ≤ BOSS_JOIN_RADIUS_M                    → BOSS_JOIN
 *    currently BOSS_JOIN && effectiveDist ≤ hysteresis      → BOSS_JOIN (anti-flicker)
 *    effectiveDist ≤ discovery_radius_m                    → DISCOVERED
 *    else                                                  → OUTSIDE
 *
 *  ENEMY type:
 *    effectiveDist ≤ aggro_radius_m                        → AGGRO
 *    currently AGGRO && effectiveDist ≤ hysteresis         → AGGRO (anti-flicker)
 *    effectiveDist ≤ discovery_radius_m                    → DISCOVERED
 *    else                                                  → OUTSIDE
 *
 *  All other types (LOCATION, NPC, STORE, SAFE_ZONE):
 *    effectiveDist ≤ interaction_radius_m                  → INTERACTING
 *    currently INTERACTING && effectiveDist ≤ hysteresis   → INTERACTING (anti-flicker)
 *    effectiveDist ≤ discovery_radius_m                    → DISCOVERED
 *    else                                                  → OUTSIDE
 *
 * @param effectiveDist  Accuracy-adjusted distance in metres (≥ 0)
 * @param obj            WorldObject with its per-feature radii
 * @param currentZone    Previously stored zone (OUTSIDE if no record exists)
 * @returns              New zone after applying transition rules
 */
export function computeNewZone(
  effectiveDist: number,
  obj: SpatialWorldObject,
  currentZone: ProximityZone,
): ProximityZone {
  const {
    discoveryRadiusM,
    interactionRadiusM,
    exitHysteresisRadiusM,
    aggroRadiusM,
  } = obj;

  // ── BOSS type ──────────────────────────────────────────────────────────────
  if (obj.type === "BOSS") {
    if (effectiveDist <= BOSS_JOIN_RADIUS_M) {
      return "BOSS_JOIN";
    }
    // Hysteresis: stay BOSS_JOIN until outside the hysteresis ring
    if (
      currentZone === "BOSS_JOIN" &&
      effectiveDist <= exitHysteresisRadiusM
    ) {
      return "BOSS_JOIN";
    }
    if (effectiveDist <= discoveryRadiusM) return "DISCOVERED";
    return "OUTSIDE";
  }

  // ── ENEMY type ─────────────────────────────────────────────────────────────
  if (obj.type === "ENEMY") {
    if (effectiveDist <= aggroRadiusM) {
      return "AGGRO";
    }
    // Hysteresis: stay AGGRO until outside the hysteresis ring
    if (
      currentZone === "AGGRO" &&
      effectiveDist <= exitHysteresisRadiusM
    ) {
      return "AGGRO";
    }
    if (effectiveDist <= discoveryRadiusM) return "DISCOVERED";
    return "OUTSIDE";
  }

  // ── LOCATION / NPC / STORE / SAFE_ZONE ────────────────────────────────────
  if (effectiveDist <= interactionRadiusM) {
    return "INTERACTING";
  }
  // Hysteresis: stay INTERACTING until outside the hysteresis ring
  if (
    currentZone === "INTERACTING" &&
    effectiveDist <= exitHysteresisRadiusM
  ) {
    return "INTERACTING";
  }
  if (effectiveDist <= discoveryRadiusM) return "DISCOVERED";
  return "OUTSIDE";
}

// ── Batch evaluation helper ───────────────────────────────────────────────────

/**
 * Evaluate zone transitions for all world objects that are within the player's
 * extended discovery radius (pre-filtered by PostGIS ST_DWithin in the service).
 *
 * @param nearbyObjects     WorldObjects with their PostGIS-computed distances
 * @param currentStates     Map of worldObjectId → current ProximityZone
 * @returns                 List of ZoneResult for all evaluated objects
 *                          (includes unchanged zones for full state refresh)
 */
export function evaluateZones(
  nearbyObjects: Array<SpatialWorldObject & { actualDistanceM: number; effectiveDistanceM: number }>,
  currentStates: Map<string, ProximityZone>,
): ZoneResult[] {
  return nearbyObjects.map((obj) => {
    const currentZone = currentStates.get(obj.id) ?? "OUTSIDE";
    const newZone = computeNewZone(obj.effectiveDistanceM, obj, currentZone);

    return {
      worldObjectId: obj.id,
      previousZone: currentZone,
      newZone,
      effectiveDistanceM: obj.effectiveDistanceM,
      actualDistanceM: obj.actualDistanceM,
      changed: newZone !== currentZone,
    };
  });
}

/**
 * For objects that were previously non-OUTSIDE but are now out of any radius
 * (not in nearbyObjects), generate synthetic OUTSIDE transitions.
 *
 * @param nearbyIds         Set of IDs returned by the PostGIS nearby query
 * @param currentStates     Full current state map for the player
 * @returns                 Exit transitions for objects no longer in range
 */
export function computeExitTransitions(
  nearbyIds: Set<string>,
  currentStates: Map<string, ProximityZone>,
): ZoneResult[] {
  const exits: ZoneResult[] = [];

  for (const [worldObjectId, zone] of currentStates.entries()) {
    if (zone !== "OUTSIDE" && !nearbyIds.has(worldObjectId)) {
      exits.push({
        worldObjectId,
        previousZone: zone,
        newZone: "OUTSIDE",
        effectiveDistanceM: Infinity,
        actualDistanceM: Infinity,
        changed: true,
      });
    }
  }

  return exits;
}
