/**
 * Seed Control Service – Epic 9
 * Allows GM to trigger re-seed from GeoJSON file.
 * Wraps the seed.ts logic in a service API.
 */

import type { FastifyBaseLogger } from "fastify";
import { db } from "../../db/client.js";
import { auditEvents } from "../../db/schema/media.js";
import { worldObjects } from "../../db/schema/world.js";
import { questDefinitions } from "../../db/schema/quest.js";
import { eq, sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GameFeatureCollectionSchema,
  RawFeatureSchema,
  GameFeatureParsers,
  type LocationCandidateFeature,
  type QuestDefinitionFeature,
  type EnemyEncounterFeature,
  type GameFeatureType,
} from "@jlw/contracts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Path to the GeoJSON relative to the repo root. */
const DEFAULT_GEOJSON_PATH = path.resolve(
  __dirname,
  "../../../docs/Via_Romae_GameObjects_v0.8.geojson",
);
const AUTHORED_CONTENT_PATH = path.resolve(__dirname, "../../../content/quest-content-v0.10.json");
const authoredQuests = (JSON.parse(fs.readFileSync(AUTHORED_CONTENT_PATH, "utf8")) as { quests: Record<string, Record<string, unknown>> }).quests;

export interface SeedReport {
  totalFeaturesRead: number;
  locationCandidatesImported: number;
  enemyEncountersImported: number;
  questDefinitionsImported: number;
  skippedFiltered: number;
  errors: number;
  elapsedMs: number;
}

export class SeedControlService {
  private logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger.child({ module: "SeedControlService" });
  }

  /**
   * Trigger a full re-seed from the GeoJSON file.
   * This will upsert all WorldObjects and QuestDefinitions.
   * APPROVED + publishable content filter is ALWAYS applied (production mode).
   */
  async triggerReSeed(actorId: string): Promise<SeedReport> {
    this.logger.info({ actorId }, "Re-seed triggered by GM");

    const startMs = Date.now();

    // Audit log
    await db.insert(auditEvents).values({
      actorId,
      action: "SEED_CONTROL",
      targetRefs: null,
      payload: { action: "RE_SEED", timestamp: new Date().toISOString() },
    });

    // Read GeoJSON
    if (!fs.existsSync(DEFAULT_GEOJSON_PATH)) {
      throw new Error(`GeoJSON file not found: ${DEFAULT_GEOJSON_PATH}`);
    }

    const rawJson = fs.readFileSync(DEFAULT_GEOJSON_PATH, "utf8");
    const rawCollection = JSON.parse(rawJson) as unknown;

    const collectionResult = GameFeatureCollectionSchema.safeParse(rawCollection);
    if (!collectionResult.success) {
      throw new Error(
        "GeoJSON validation failed: " + JSON.stringify(collectionResult.error.format()),
      );
    }

    const collection = collectionResult.data;
    const defaults = collection.metadata.implementation_defaults;
    const totalRead = collection.features.length;

    let locationCandidatesImported = 0;
    let enemyEncountersImported = 0;
    let questDefinitionsImported = 0;
    let skippedFiltered = 0;
    let errors = 0;

    const validLocationCandidates: LocationCandidateFeature[] = [];
    const validQuestDefinitions: QuestDefinitionFeature[] = [];
    const validEnemyEncounters: EnemyEncounterFeature[] = [];

    // Parse and filter features
    for (const rawFeature of collection.features) {
      const rawResult = RawFeatureSchema.safeParse(rawFeature);
      if (!rawResult.success) {
        errors++;
        continue;
      }

      const featureType = rawResult.data.properties.feature_type as string;
      const parser = GameFeatureParsers[featureType as GameFeatureType];
      if (!parser) {
        errors++;
        continue;
      }

      const parseResult = parser.safeParse(rawFeature);
      if (!parseResult.success) {
        errors++;
        continue;
      }

      const parsedFeature = parseResult.data;
      const props = parsedFeature.properties as {
        content_status?: string;
        publishable: boolean;
      };

      // Content filter: APPROVED + publishable ONLY
      if (props.content_status !== "APPROVED" || !props.publishable) {
        skippedFiltered++;
        continue;
      }

      // Enqueue for upsert
      if (featureType === "location_candidate") {
        validLocationCandidates.push(parsedFeature as LocationCandidateFeature);
      } else if (featureType === "quest_definition") {
        validQuestDefinitions.push(parsedFeature as QuestDefinitionFeature);
      } else if (featureType === "enemy_encounter") {
        validEnemyEncounters.push(parsedFeature as EnemyEncounterFeature);
      } else {
        skippedFiltered++;
      }
    }

    // Upsert WorldObjects (location_candidate)
    for (const feature of validLocationCandidates) {
      await this.upsertWorldObject(feature, defaults, "LOCATION");
      locationCandidatesImported++;
    }

    // Upsert WorldObjects (enemy_encounter)
    for (const feature of validEnemyEncounters) {
      await this.upsertWorldObject(feature, defaults, "ENEMY");
      enemyEncountersImported++;
    }

    // Upsert QuestDefinitions
    for (const feature of validQuestDefinitions) {
      await this.upsertQuestDefinition(feature);
      questDefinitionsImported++;
    }

    const elapsedMs = Date.now() - startMs;

    this.logger.info(
      {
        totalRead,
        locationCandidatesImported,
        enemyEncountersImported,
        questDefinitionsImported,
        skippedFiltered,
        errors,
        elapsedMs,
      },
      "Re-seed completed",
    );

    return {
      totalFeaturesRead: totalRead,
      locationCandidatesImported,
      enemyEncountersImported,
      questDefinitionsImported,
      skippedFiltered,
      errors,
      elapsedMs,
    };
  }

  /**
   * Helper: Upsert a WorldObject from a Feature.
   */
  private async upsertWorldObject(
    feature: LocationCandidateFeature | EnemyEncounterFeature,
    defaults: any,
    type: "LOCATION" | "ENEMY",
  ): Promise<void> {
    const props = feature.properties;
    const coords = this.extractCoords(feature.geometry);

    const isEnemy = type === "ENEMY";

    const interactionRadiusM = isEnemy
      ? defaults.location_interaction_radius_m
      : ((props as any).geofence?.interaction_radius_m ??
          defaults.location_interaction_radius_m);

    const exitHysteresisRadiusM = isEnemy
      ? defaults.interaction_exit_hysteresis_radius_m
      : ((props as any).geofence?.exit_hysteresis_radius_m ??
          defaults.interaction_exit_hysteresis_radius_m);

    const discoveryRadiusM = isEnemy
      ? defaults.discovery_radius_m
      : ((props as any).geofence?.discovery_radius_m ?? defaults.discovery_radius_m);

    const aggroRadiusM = isEnemy
      ? ((props as any).aggro_radius_m ?? defaults.enemy_aggro_radius_m)
      : defaults.enemy_aggro_radius_m;

    const name =
      "name" in props && typeof props.name === "string" ? props.name : feature.id;

    const day = "day" in props && typeof props.day === "string" ? props.day : null;

    const cluster =
      "cluster" in props && typeof props.cluster === "string" ? props.cluster : null;

    await db
      .insert(worldObjects)
      .values({
        externalId: feature.id,
        type,
        name,
        day,
        cluster,
        lat: coords ? coords[0] : null,
        lng: coords ? coords[1] : null,
        discoveryRadiusM,
        interactionRadiusM,
        exitHysteresisRadiusM,
        aggroRadiusM,
        contentStatus: this.mapContentStatus(props.content_status ?? "DRAFT"),
        publishable: props.publishable,
        rawPropertiesJson: JSON.stringify(props),
        contentVersion: 1,
      })
      .onConflictDoUpdate({
        target: worldObjects.externalId,
        set: {
          name,
          day,
          cluster,
          lat: coords ? coords[0] : null,
          lng: coords ? coords[1] : null,
          discoveryRadiusM,
          interactionRadiusM,
          exitHysteresisRadiusM,
          aggroRadiusM,
          contentStatus: this.mapContentStatus(props.content_status ?? "DRAFT"),
          publishable: props.publishable,
          rawPropertiesJson: JSON.stringify(props),
          contentVersion: sql`${worldObjects.contentVersion} + 1`,
        },
      });
  }

  /**
   * Helper: Upsert a QuestDefinition.
   */
  private async upsertQuestDefinition(feature: QuestDefinitionFeature): Promise<void> {
    const props = feature.properties;

    const contentJson = JSON.stringify({
      story_conflict: (props as any).story_conflict,
      dramatic_arc: (props as any).dramatic_arc,
      ordered_candidate_ids: props.ordered_candidate_ids,
      timer_refs: props.timer_refs,
      has_timer_stage: props.has_timer_stage,
      duration_min: (props as any).duration_min,
      duration_max: (props as any).duration_max,
      slot_progress: (props as any).slot_progress,
      prerequisites: (props as any).prerequisites,
      completion_rule: (props as any).completion_rule,
      fallback_rule: (props as any).fallback_rule,
      reward_encounter_profile: (props as any).reward_encounter_profile,
      class_spotlight: (props as any).class_spotlight,
      quest_giver_id: (props as any).quest_giver_id,
      quest_giver_name: (props as any).quest_giver_name,
    });

    await db
      .insert(questDefinitions)
      .values({
        externalId: props.quest_id,
        title: props.title,
        type: this.mapQuestType(props.quest_type),
        day: props.day,
        contentJson,
        authoredContent: authoredQuests[props.quest_id] ?? {},
        repeatable: Boolean((props as any).repeatable),
        repeatCooldownSeconds: (props as any).repeat_cooldown_seconds ?? null,
      })
      .onConflictDoUpdate({
        target: questDefinitions.externalId,
        set: {
          title: props.title,
          type: this.mapQuestType(props.quest_type),
          day: props.day,
          contentJson,
          authoredContent: authoredQuests[props.quest_id] ?? {},
          repeatable: Boolean((props as any).repeatable),
          repeatCooldownSeconds: (props as any).repeat_cooldown_seconds ?? null,
        },
      });
  }

  /**
   * Helper: Extract coordinates from Feature geometry.
   */
  private extractCoords(
    geometry: { type: string; coordinates: unknown } | null,
  ): [number, number] | null {
    if (!geometry) return null;
    if (geometry.type === "Point") {
      const [lng, lat] = geometry.coordinates as [number, number];
      return [lat, lng];
    }
    if (geometry.type === "MultiPoint") {
      const coords = geometry.coordinates as [number, number][];
      const first = coords[0];
      if (!first) return null;
      return [first[1], first[0]];
    }
    return null;
  }

  private mapQuestType(raw: string): "REGULAR" | "HIDDEN" | "LONG_TERM" | "MEDIA" {
    const map: Record<string, "REGULAR" | "HIDDEN" | "LONG_TERM" | "MEDIA"> = {
      REGULAER: "REGULAR",
      REGULAR: "REGULAR",
      HIDDEN: "HIDDEN",
      LONG_TERM: "LONG_TERM",
      MEDIA: "MEDIA",
      MEDIA_LOCAL: "MEDIA",
      MEDIA_LANGZEIT: "LONG_TERM",
    };
    return map[raw] ?? "REGULAR";
  }

  private mapContentStatus(
    raw: string,
  ): "DRAFT" | "FIELD_CHECK_REQUIRED" | "EDITORIAL_REVIEW" | "APPROVED" {
    const allowed = [
      "DRAFT",
      "FIELD_CHECK_REQUIRED",
      "EDITORIAL_REVIEW",
      "APPROVED",
    ] as const;
    if ((allowed as readonly string[]).includes(raw)) {
      return raw as (typeof allowed)[number];
    }
    return "DRAFT";
  }
}
