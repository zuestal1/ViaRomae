import { z } from "zod";

// ── Location update (player → server) ────────────────────────────────────────

/** Body sent by the player client when the Geolocation API fires. */
export const UpdateLocationRequestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** GPS horizontal accuracy in metres (from GeolocationCoordinates.accuracy). */
  accuracy: z.number().positive().max(50),
  /** Optional: opaque device fingerprint for session correlation. */
  deviceId: z.string().max(128).optional(),
});
export type UpdateLocationRequest = z.infer<typeof UpdateLocationRequestSchema>;

/** Server response after persisting the player's location. */
export const UpdateLocationResponseSchema = z.object({
  playerId: z.string().uuid(),
  lat: z.number(),
  lng: z.number(),
  accuracy: z.number(),
  updatedAt: z.string().datetime(),
});
export type UpdateLocationResponse = z.infer<
  typeof UpdateLocationResponseSchema
>;

// ── Interaction distance check ────────────────────────────────────────────────

/**
 * Used internally (and optionally exposed) to validate whether a player
 * is within the interaction radius of a world object.
 *
 * effectiveDistance = max(0, haversineMetres - min(accuracy, 10 m))
 *
 * This gives the player the benefit of the doubt when GPS is imprecise.
 */
export const DistanceCheckSchema = z.object({
  /** Actual distance between the two points in metres. */
  actualDistanceM: z.number().nonnegative(),
  /** Accuracy-adjusted distance used for radius validation. */
  effectiveDistanceM: z.number().nonnegative(),
  /** Whether effectiveDistanceM ≤ targetRadiusM. */
  withinRange: z.boolean(),
});
export type DistanceCheck = z.infer<typeof DistanceCheckSchema>;

// ── Proximity zone ────────────────────────────────────────────────────────────

/**
 * Spatial proximity zone a player can occupy relative to a WorldObject.
 *
 * OUTSIDE      → farther than discovery_radius_m
 * DISCOVERED   → within discovery_radius_m; map marker visible
 * INTERACTING  → within interaction_radius_m (or hysteresis), interaction active
 * AGGRO        → within enemy_aggro_radius_m (ENEMY-type objects only)
 * BOSS_JOIN    → within boss_join_radius_m = 30 m (BOSS-type objects only)
 */
export const ProximityZoneSchema = z.enum([
  "OUTSIDE",
  "DISCOVERED",
  "INTERACTING",
  "AGGRO",
  "BOSS_JOIN",
]);
export type ProximityZone = z.infer<typeof ProximityZoneSchema>;

// ── WorldObjectNearby ─────────────────────────────────────────────────────────

/**
 * Response shape for GET /api/v1/geo/world-objects.
 * Returns WorldObjects within discovery_radius_m of the player, enriched
 * with the current effective distance and proximity zone.
 *
 * Note: WorldObjectTypeSchema / WorldObjectType are defined in world.ts
 * and re-exported from @jlw/contracts index; imported here for local use.
 */
import { WorldObjectTypeSchema } from "./world.js";

export const WorldObjectNearbySchema = z.object({
  id: z.string().uuid(),
  externalId: z.string(),
  type: WorldObjectTypeSchema,
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  cluster: z.string().nullable(),
  discoveryRadiusM: z.number().int().positive(),
  interactionRadiusM: z.number().int().positive(),
  exitHysteresisRadiusM: z.number().int().positive(),
  aggroRadiusM: z.number().int().positive(),
  /** Current computed zone for the requesting player. */
  zone: ProximityZoneSchema,
  /** Accuracy-adjusted distance in metres. */
  effectiveDistanceM: z.number().nonnegative(),
});
export type WorldObjectNearby = z.infer<typeof WorldObjectNearbySchema>;

/** Response wrapper for the world-objects endpoint. */
export const WorldObjectsResponseSchema = z.object({
  objects: z.array(WorldObjectNearbySchema),
  playerLat: z.number(),
  playerLng: z.number(),
  accuracy: z.number(),
});
export type WorldObjectsResponse = z.infer<typeof WorldObjectsResponseSchema>;

// ── WebSocket radius events ───────────────────────────────────────────────────

/**
 * Emitted to all team WebSocket clients when a player's proximity zone
 * relative to a WorldObject changes.
 *
 * Direction: server → client (push only; clients don't send events back).
 *
 * Examples:
 *   OUTSIDE → DISCOVERED   : show map marker
 *   DISCOVERED → INTERACTING: unlock NPC dialog / quest accept button
 *   OUTSIDE → AGGRO        : trigger PvE encounter warning
 *   * → BOSS_JOIN          : open boss-join modal
 *   INTERACTING → DISCOVERED: player walked away – deactivate interaction
 */
export const RadiusEventSchema = z.object({
  event: z.literal("radius.transition"),
  playerId: z.string().uuid(),
  playerName: z.string(),
  teamId: z.string().uuid(),
  worldObjectId: z.string().uuid(),
  worldObjectName: z.string(),
  worldObjectType: WorldObjectTypeSchema,
  previousZone: ProximityZoneSchema,
  newZone: ProximityZoneSchema,
  effectiveDistanceM: z.number(),
  timestamp: z.string().datetime(),
});
export type RadiusEvent = z.infer<typeof RadiusEventSchema>;

/**
 * Emitted to confirm a successful WebSocket handshake.
 * Carries the initial world-objects state so the client can bootstrap
 * its map overlay without a separate HTTP request.
 */
export const WsConnectedEventSchema = z.object({
  event: z.literal("ws.connected"),
  playerId: z.string().uuid(),
  teamId: z.string().uuid(),
  nearbyObjects: z.array(WorldObjectNearbySchema),
  timestamp: z.string().datetime(),
});
export type WsConnectedEvent = z.infer<typeof WsConnectedEventSchema>;

// ── PlayArea ──────────────────────────────────────────────────────────────────

/**
 * A single game-day boundary polygon returned by GET /api/v1/geo/play-areas.
 * `geojson` is a GeoJSON Polygon or MultiPolygon object – ready to be fed
 * directly into a MapLibre GeoJSON source.
 */
export const PlayAreaSchema = z.object({
  id: z.string().uuid(),
  /** 1-based game day number. */
  day: z.number().int().positive(),
  /** Human-readable label, e.g. "Tag 1 – Via Sacra". Nullable if not set. */
  name: z.string().nullable(),
  /**
   * GeoJSON geometry for the day boundary.
   * Stored as a plain object so the frontend can pass it directly to MapLibre.
   * Null when no polygon has been defined yet.
   */
  geojson: z
    .object({
      type: z.enum(["Polygon", "MultiPolygon"]),
      coordinates: z.array(z.unknown()),
    })
    .nullable(),
});
export type PlayArea = z.infer<typeof PlayAreaSchema>;

/** Response body for GET /api/v1/geo/play-areas. */
export const PlayAreasResponseSchema = z.object({
  areas: z.array(PlayAreaSchema),
});
export type PlayAreasResponse = z.infer<typeof PlayAreasResponseSchema>;
