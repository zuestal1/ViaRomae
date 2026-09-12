/**
 * seed.ts – Content Data Pipeline for Via Romae GeoJSON v0.8
 * ============================================================
 *
 * Usage:
 *   npm run seed                  # runs with default APPROVED+publishable filter
 *   SEED_SKIP_FILTER=true npm run seed  # dev-only: bypass content filter
 *
 * Algorithm:
 *   1. Read & top-level-validate the GeoJSON FeatureCollection.
 *   2. For each Feature:
 *      a. Identify feature_type (raw read, no type-specific parse yet).
 *      b. Run type-specific Zod parse; record errors and skip invalid features.
 *      c. Apply production content filter (APPROVED + publishable).
 *      d. Queue feature for upsert.
 *   3. Pass 1 – Upsert WorldObjects (location_candidate + enemy_encounter).
 *   4. Pass 2 – Upsert QuestDefinitions.
 *   5. Pass 3 – Build lookup maps (externalId → internalId).
 *   6. Pass 4 – Upsert QuestSteps from quest_step_refs.
 *   7. Pass 5 – Upsert QuestStations from quest_stations.
 *   8. Print Seed Report.
 *
 * Production safety:
 *   In NODE_ENV=production the content filter is IMMUTABLY active.
 *   SEED_SKIP_FILTER is silently ignored in production.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";

import { db } from "../src/db/client.js";
import { worldObjects, contentStatusEnum } from "../src/db/schema/world.js";
import {
  questDefinitions,
  questSteps,
  questStations,
  questStepWaypoints,
} from "../src/db/schema/quest.js";

import {
  GameFeatureCollectionSchema,
  RawFeatureSchema,
  GameFeatureParsers,
  type LocationCandidateFeature,
  type QuestDefinitionFeature,
  type EnemyEncounterFeature,
  type NavigationChallengeFeature,
  type GameFeatureType,
  type ImplementationDefaults,
} from "@jlw/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Path to the GeoJSON relative to the repo root. */
const GEOJSON_PATH = path.resolve(
  __dirname,
  "../../../docs/Via_Romae_GameObjects_v0.8.geojson",
);
const QUEST_CONTENT_PATH = path.resolve(__dirname, "../content/quest-content-v0.10.json");
const STORE_CONTENT_PATH = path.resolve(__dirname, "../content/store-content-v0.17.json");
type AuthoredQuest = { type: string; [key: string]: unknown; steps: Array<{ stepId: string; [key: string]: unknown }> };
const authoredQuests = (JSON.parse(fs.readFileSync(QUEST_CONTENT_PATH, "utf8")) as {
  quests: Record<string, AuthoredQuest>;
}).quests;
type StoreContent = { stores: Array<{ externalId: string; catalog: Array<{ definitionId: string; price: number }> }> };
const storeContent = JSON.parse(fs.readFileSync(STORE_CONTENT_PATH, "utf8")) as StoreContent;

const IS_PRODUCTION = process.env["NODE_ENV"] === "production";

/**
 * Skip the APPROVED+publishable filter in development.
 * Silently ignored in production – the filter is always active there.
 */
const SKIP_FILTER =
  !IS_PRODUCTION && process.env["SEED_SKIP_FILTER"] === "true";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type FeatureTypeKey = GameFeatureType | "unknown";

interface SeedCounter {
  imported: number;
  skipped_filter: number;
  skipped_missing_ref: number;
  errored: number;
}

type Report = Record<FeatureTypeKey, SeedCounter>;

function emptyCounter(): SeedCounter {
  return {
    imported: 0,
    skipped_filter: 0,
    skipped_missing_ref: 0,
    errored: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content filter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the feature passes the production content filter.
 * Production: always enforced.
 * Development: bypassed when SEED_SKIP_FILTER=true.
 */
function passesContentFilter(props: {
  content_status?: string;
  publishable: boolean;
}): boolean {
  if (SKIP_FILTER) return true;
  return props.content_status === "APPROVED" && props.publishable === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Map a GeoJSON quest_type string to the DB enum value. */
function mapQuestType(
  raw: string,
): "REGULAR" | "HIDDEN" | "LONG_TERM" | "MEDIA" {
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

/** Map a GeoJSON content_status string to the DB enum value. */
function mapContentStatus(
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

/** Safely map a GeoJSON step_action_type to the DB enum or "OTHER". */
function mapStepActionType(raw: string): string {
  const aliases: Record<string, string> = {
    TAKE_PHOTO: "UPLOAD_MEDIA", TAKE_VIDEO: "UPLOAD_MEDIA", COLLECT_MEDIA: "UPLOAD_MEDIA",
    SUBMIT_FOR_REVIEW: "TEAM_DECISION", BOSS_PARTICIPATION: "DEFEAT_ENEMY",
  };
  raw = aliases[raw] ?? raw;
  const allowed = [
    "REACH_LOCATION",
    "NAVIGATION_CHALLENGE",
    "VISIT_MULTIPLE_LOCATIONS",
    "ANSWER_QUESTION",
    "SOLVE_PUZZLE",
    "DEFEAT_ENEMY",
    "DISCOVER_NPC",
    "TALK_TO_NPC",
    "ACCEPT_QUEST",
    "UPLOAD_MEDIA",
    "USE_ITEM",
    "CLASS_ACTION",
    "TEAM_DECISION",
  ];
  return allowed.includes(raw) ? raw : "OTHER";
}

/** Safely map a GeoJSON flow_phase to the DB enum or "OBJECTIVE". */
function mapFlowPhase(raw: string): string {
  const allowed = [
    "DISCOVER",
    "DIALOGUE",
    "ACCEPT",
    "OBJECTIVE",
    "BONUS_OBJECTIVE",
    "COMPLETE",
  ];
  return allowed.includes(raw) ? raw : "OBJECTIVE";
}

/** Extract [lat, lng] from a Point or MultiPoint geometry, or null. */
function extractCoords(
  geometry: { type: string; coordinates: unknown } | null,
): [number, number] | null {
  if (!geometry) return null;
  if (geometry.type === "Point") {
    const [lng, lat] = geometry.coordinates as [number, number];
    return [lat, lng];
  }
  if (geometry.type === "MultiPoint") {
    const coords = geometry.coordinates as [number, number][];
    // Use the first coordinate as the representative point.
    const first = coords[0];
    if (!first) return null;
    return [first[1], first[0]];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 1 – Upsert WorldObjects (location_candidate + enemy_encounter)
// ─────────────────────────────────────────────────────────────────────────────

async function upsertWorldObject(
  feature: LocationCandidateFeature | EnemyEncounterFeature,
  defaults: ImplementationDefaults,
  report: Report,
): Promise<void> {
  const props = feature.properties;
  const typeKey = props.feature_type as FeatureTypeKey;
  const counter = report[typeKey] ?? emptyCounter();

  const coords = extractCoords(feature.geometry);

  // Determine game type and radii based on feature_type
  const isEnemy = props.feature_type === "enemy_encounter";
  const isStore = !isEnemy &&
    ((props as LocationCandidateFeature["properties"] & { support_roles?: string[] }).support_roles ?? [])
      .includes("STORE_LOCATION_CANDIDATE");

  const interactionRadiusM = isEnemy
    ? defaults.location_interaction_radius_m
    : ((props as LocationCandidateFeature["properties"]).geofence
        ?.interaction_radius_m ?? defaults.location_interaction_radius_m);

  const exitHysteresisRadiusM = isEnemy
    ? defaults.interaction_exit_hysteresis_radius_m
    : ((props as LocationCandidateFeature["properties"]).geofence
        ?.exit_hysteresis_radius_m ?? defaults.interaction_exit_hysteresis_radius_m);

  const discoveryRadiusM = isEnemy
    ? defaults.discovery_radius_m
    : ((props as LocationCandidateFeature["properties"]).geofence
        ?.discovery_radius_m ?? defaults.discovery_radius_m);

  const aggroRadiusM = isEnemy
    ? ((props as EnemyEncounterFeature["properties"]).aggro_radius_m ??
        defaults.enemy_aggro_radius_m)
    : defaults.enemy_aggro_radius_m;

  const name =
    "name" in props && typeof props.name === "string"
      ? props.name
      : feature.id;

  const day =
    "day" in props && typeof props.day === "string" ? props.day : undefined;

  const cluster =
    "cluster" in props && typeof props.cluster === "string"
      ? props.cluster
      : undefined;

  await db
    .insert(worldObjects)
    .values({
      externalId: feature.id,
      type: isEnemy ? "ENEMY" : isStore ? "STORE" : "LOCATION",
      name,
      day: day ?? null,
      cluster: cluster ?? null,
      lat: coords ? coords[0] : null,
      lng: coords ? coords[1] : null,
      discoveryRadiusM,
      interactionRadiusM,
      exitHysteresisRadiusM,
      aggroRadiusM,
      contentStatus: mapContentStatus(props.content_status ?? "DRAFT"),
      // In dev (SKIP_FILTER) mode force publishable=true so objects are
      // discoverable without needing APPROVED content in the GeoJSON.
      publishable: SKIP_FILTER ? true : props.publishable,
      rawPropertiesJson: JSON.stringify(props),
      contentVersion: 1,
    })
    .onConflictDoUpdate({
      target: worldObjects.externalId,
      set: {
        type: isEnemy ? "ENEMY" : isStore ? "STORE" : "LOCATION",
        name,
        day: day ?? null,
        cluster: cluster ?? null,
        lat: coords ? coords[0] : null,
        lng: coords ? coords[1] : null,
        discoveryRadiusM,
        interactionRadiusM,
        exitHysteresisRadiusM,
        aggroRadiusM,
        contentStatus: mapContentStatus(props.content_status ?? "DRAFT"),
        publishable: SKIP_FILTER ? true : props.publishable,
        rawPropertiesJson: JSON.stringify(props),
        contentVersion: sql`${worldObjects.contentVersion} + 1`,
      },
    });

  counter.imported++;
  report[typeKey] = counter;
}

/** Upsert only catalog entries whose canonical item_def was installed by migrations. */
async function upsertStoreCatalogs(worldObjectByExternalId: Map<string, string>): Promise<void> {
  for (const store of storeContent.stores) {
    const storeId = worldObjectByExternalId.get(store.externalId);
    if (!storeId) throw new Error(`Production store was not imported: ${store.externalId}`);

    for (const item of store.catalog) {
      if (!Number.isInteger(item.price) || item.price <= 0) {
        throw new Error(`Invalid store price for ${store.externalId}/${item.definitionId}`);
      }
      const result = await db.execute(sql`
        INSERT INTO store_catalog_item (id, store_id, definition_id, price)
        SELECT gen_random_uuid(), ${storeId}::uuid, definition.key, ${item.price}
        FROM item_def definition WHERE definition.key = ${item.definitionId}
        ON CONFLICT (store_id, definition_id) DO UPDATE SET price = EXCLUDED.price
        RETURNING id
      `);
      if (result.rows.length !== 1) {
        throw new Error(`Store item is not defined by the production migrations: ${item.definitionId}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 2 – Upsert QuestDefinitions
// ─────────────────────────────────────────────────────────────────────────────

async function upsertQuestDefinition(
  feature: QuestDefinitionFeature,
  report: Report,
): Promise<void> {
  const props = feature.properties;
  const authored = authoredQuests[props.quest_id];
  const counter = report["quest_definition"] ?? emptyCounter();

  const contentJson = JSON.stringify({
    story_conflict: (props as Record<string, unknown>).story_conflict,
    dramatic_arc: (props as Record<string, unknown>).dramatic_arc,
    ordered_candidate_ids: props.ordered_candidate_ids,
    timer_refs: props.timer_refs,
    has_timer_stage: props.has_timer_stage,
    duration_min: (props as Record<string, unknown>).duration_min,
    duration_max: (props as Record<string, unknown>).duration_max,
    slot_progress: (props as Record<string, unknown>).slot_progress,
    prerequisites: (props as Record<string, unknown>).prerequisites,
    completion_rule: (props as Record<string, unknown>).completion_rule,
    fallback_rule: (props as Record<string, unknown>).fallback_rule,
    reward_encounter_profile: (props as Record<string, unknown>)
      .reward_encounter_profile,
    class_spotlight: (props as Record<string, unknown>).class_spotlight,
    quest_giver_id: (props as Record<string, unknown>).quest_giver_id,
    quest_giver_name: (props as Record<string, unknown>).quest_giver_name,
  });

  await db
    .insert(questDefinitions)
    .values({
      externalId: props.quest_id,
      title: props.title,
      type: mapQuestType(props.quest_type),
      day: props.day,
      contentJson,
      authoredContent: authored ?? {},
    })
    .onConflictDoUpdate({
      target: questDefinitions.externalId,
      set: {
        title: props.title,
        type: mapQuestType(props.quest_type),
        authoredContent: authored ?? {},
        day: props.day,
        contentJson,
      },
    });

  counter.imported++;
  report["quest_definition"] = counter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 3 – Build lookup maps
// ─────────────────────────────────────────────────────────────────────────────

async function buildLookupMaps(): Promise<{
  worldObjectByExternalId: Map<string, string>;
  questDefByExternalId: Map<string, string>;
}> {
  const woRows = await db
    .select({ id: worldObjects.id, externalId: worldObjects.externalId })
    .from(worldObjects);

  const qdRows = await db
    .select({ id: questDefinitions.id, externalId: questDefinitions.externalId })
    .from(questDefinitions);

  return {
    worldObjectByExternalId: new Map(woRows.map((r) => [r.externalId, r.id])),
    questDefByExternalId: new Map(qdRows.map((r) => [r.externalId, r.id])),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 4 – Upsert QuestSteps
// ─────────────────────────────────────────────────────────────────────────────

async function upsertQuestSteps(
  features: LocationCandidateFeature[],
  questDefByExternalId: Map<string, string>,
  report: Report,
): Promise<void> {
  // Collect unique step_ids across all location_candidates to avoid duplicates.
  const seen = new Set<string>();

  for (const feature of features) {
    const stepRefs = feature.properties.quest_step_refs;

    for (const stepRef of stepRefs) {
      if (seen.has(stepRef.step_id)) continue;
      seen.add(stepRef.step_id);

      const questDefId = questDefByExternalId.get(stepRef.quest_id);
      if (!questDefId) {
        console.warn(
          `  [QuestStep] Skipped ${stepRef.step_id}: ` +
            `QuestDefinition "${stepRef.quest_id}" not found in DB.`,
        );
        const counter = report["location_candidate"] ?? emptyCounter();
        counter.skipped_missing_ref++;
        report["location_candidate"] = counter;
        continue;
      }

      await db
        .insert(questSteps)
        .values({
          questDefinitionId: questDefId,
          stepId: stepRef.step_id,
          sequence: stepRef.sequence,
          flowPhase: mapFlowPhase(stepRef.flow_phase) as
            | "DISCOVER"
            | "DIALOGUE"
            | "ACCEPT"
            | "OBJECTIVE"
            | "BONUS_OBJECTIVE"
            | "COMPLETE",
          stepActionType: mapStepActionType(stepRef.step_action_type) as
            | "REACH_LOCATION"
            | "NAVIGATION_CHALLENGE"
            | "VISIT_MULTIPLE_LOCATIONS"
            | "ANSWER_QUESTION"
            | "SOLVE_PUZZLE"
            | "DEFEAT_ENEMY"
            | "DISCOVER_NPC"
            | "TALK_TO_NPC"
            | "ACCEPT_QUEST"
            | "UPLOAD_MEDIA"
            | "USE_ITEM"
            | "CLASS_ACTION"
            | "TEAM_DECISION"
            | "OTHER",
          stepCategory: stepRef.step_category,
          gddObjectiveType: stepRef.gdd_objective_type ?? null,
          targetRef: stepRef.target_ref,
          required: stepRef.required,
          authoredContent: authoredQuests[stepRef.quest_id]?.steps.find((item) => item.stepId === stepRef.step_id) ?? {},
        })
        .onConflictDoUpdate({
          target: questSteps.stepId,
          set: {
            sequence: stepRef.sequence,
            flowPhase: mapFlowPhase(stepRef.flow_phase) as
              | "DISCOVER"
              | "DIALOGUE"
              | "ACCEPT"
              | "OBJECTIVE"
              | "BONUS_OBJECTIVE"
              | "COMPLETE",
            stepActionType: mapStepActionType(stepRef.step_action_type) as
              | "REACH_LOCATION"
              | "NAVIGATION_CHALLENGE"
              | "VISIT_MULTIPLE_LOCATIONS"
              | "ANSWER_QUESTION"
              | "SOLVE_PUZZLE"
              | "DEFEAT_ENEMY"
              | "DISCOVER_NPC"
              | "TALK_TO_NPC"
              | "ACCEPT_QUEST"
              | "UPLOAD_MEDIA"
              | "USE_ITEM"
              | "CLASS_ACTION"
              | "TEAM_DECISION"
              | "OTHER",
            stepCategory: stepRef.step_category,
            gddObjectiveType: stepRef.gdd_objective_type ?? null,
            targetRef: stepRef.target_ref,
            required: stepRef.required,
            authoredContent: authoredQuests[stepRef.quest_id]?.steps.find((item) => item.stepId === stepRef.step_id) ?? {},
          },
        });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 5 – Upsert QuestStations
// ─────────────────────────────────────────────────────────────────────────────

async function upsertQuestStations(
  features: LocationCandidateFeature[],
  worldObjectByExternalId: Map<string, string>,
  questDefByExternalId: Map<string, string>,
  report: Report,
): Promise<void> {
  for (const feature of features) {
    const woId = worldObjectByExternalId.get(feature.id);
    if (!woId) {
      // Should not happen – WorldObject was just upserted.
      console.warn(`  [QuestStation] WorldObject not found for ${feature.id}`);
      continue;
    }

    for (const station of feature.properties.quest_stations) {
      const questDefId = questDefByExternalId.get(station.quest_id);
      if (!questDefId) {
        console.warn(
          `  [QuestStation] Skipped station at ${feature.id} ` +
            `for quest "${station.quest_id}": QuestDefinition not in DB.`,
        );
        const counter = report["location_candidate"] ?? emptyCounter();
        counter.skipped_missing_ref++;
        report["location_candidate"] = counter;
        continue;
      }

      // Upsert on composite natural key (worldObjectId, questDefinitionId, sequence).
      // Drizzle does not support multi-column conflict targets via the ORM
      // helper in all versions, so we use a raw SQL ON CONFLICT clause.
      await db.execute(sql`
        INSERT INTO quest_station (
          id,
          world_object_id,
          quest_definition_id,
          sequence,
          role,
          observable_evidence,
          location_question,
          expected_answer,
          access_fallback_note,
          enemy_hook
        ) VALUES (
          gen_random_uuid(),
          ${woId},
          ${questDefId},
          ${station.sequence},
          ${station.role},
          ${station.observable_evidence ?? null},
          ${station.location_question ?? null},
          ${station.expected_answer ?? null},
          ${station.access_fallback_note ?? null},
          ${station.enemy_hook ?? null}
        )
        ON CONFLICT (world_object_id, quest_definition_id, sequence)
        DO UPDATE SET
          role                = EXCLUDED.role,
          observable_evidence = EXCLUDED.observable_evidence,
          location_question   = EXCLUDED.location_question,
          expected_answer     = EXCLUDED.expected_answer,
          access_fallback_note= EXCLUDED.access_fallback_note,
          enemy_hook          = EXCLUDED.enemy_hook
      `);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

function printReport(report: Report, totalRead: number, elapsed: number): void {
  const hr = "─".repeat(72);
  console.log("\n" + hr);
  console.log("  Via Romae GeoJSON Seed Report");
  console.log(hr);
  console.log(
    `  Total features read   : ${totalRead}`,
  );
  console.log(
    `  Elapsed               : ${(elapsed / 1000).toFixed(2)} s`,
  );
  if (SKIP_FILTER) {
    console.log("  ⚠️  Content filter BYPASSED (SEED_SKIP_FILTER=true)");
  }
  console.log(hr);
  console.log(
    "  Feature type           Imported  Skipped-filter  Skipped-ref  Errored",
  );
  console.log(hr);

  for (const [type, counts] of Object.entries(report)) {
    const col = (n: number, w = 8) => String(n).padStart(w);
    console.log(
      `  ${type.padEnd(22)} ${col(counts.imported)} ${col(counts.skipped_filter, 15)} ` +
        `${col(counts.skipped_missing_ref, 12)} ${col(counts.errored, 8)}`,
    );
  }
  console.log(hr + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startMs = Date.now();
  console.log("🌱 Via Romae seed starting …");
  console.log(`   GeoJSON : ${GEOJSON_PATH}`);
  console.log(`   NODE_ENV: ${process.env["NODE_ENV"] ?? "development"}`);
  console.log(`   Filter  : ${SKIP_FILTER ? "BYPASSED (dev)" : "ACTIVE (APPROVED + publishable)"}`);
  console.log();

  // ── 1. Read & top-level validate GeoJSON ──────────────────────────────────
  if (!fs.existsSync(GEOJSON_PATH)) {
    console.error(`❌ GeoJSON file not found: ${GEOJSON_PATH}`);
    process.exit(1);
  }

  const rawJson = fs.readFileSync(GEOJSON_PATH, "utf8");
  const rawCollection = JSON.parse(rawJson) as unknown;

  const collectionResult = GameFeatureCollectionSchema.safeParse(rawCollection);
  if (!collectionResult.success) {
    console.error("❌ GeoJSON FeatureCollection failed top-level validation:");
    console.error(collectionResult.error.format());
    process.exit(1);
  }

  const collection = collectionResult.data;
  const defaults = collection.metadata.implementation_defaults;
  const totalRead = collection.features.length;

  console.log(`   Schema  : ${collection.metadata.schema}`);
  console.log(`   Generated: ${collection.metadata.generated_at_utc}`);
  console.log(`   Features: ${totalRead}`);
  console.log();

  // ── 2. Parse and classify features ────────────────────────────────────────
  const report: Report = {
    location_candidate: emptyCounter(),
    quest_definition: emptyCounter(),
    enemy_encounter: emptyCounter(),
    quest_timer: emptyCounter(),
    navigation_challenge: emptyCounter(),
    unknown: emptyCounter(),
  };

  const validLocationCandidates: LocationCandidateFeature[] = [];
  const validQuestDefinitions: QuestDefinitionFeature[] = [];
  const validEnemyEncounters: EnemyEncounterFeature[] = [];
  const validNavigationChallenges: NavigationChallengeFeature[] = [];

  for (const rawFeature of collection.features) {
    // Step a: identify feature_type
    const rawResult = RawFeatureSchema.safeParse(rawFeature);
    if (!rawResult.success) {
      console.warn(`  [skip] Unparseable feature: ${rawResult.error.message}`);
      report["unknown"].errored++;
      continue;
    }

    const featureType = rawResult.data.properties.feature_type as FeatureTypeKey;
    const counter = report[featureType] ?? report["unknown"];

    // Step b: type-specific parse
    const parser = GameFeatureParsers[featureType as GameFeatureType];
    if (!parser) {
      console.warn(`  [skip] Unknown feature_type: "${featureType}"`);
      counter.errored++;
      continue;
    }

    const parseResult = parser.safeParse(rawFeature);
    if (!parseResult.success) {
      console.warn(
        `  [error] ${rawResult.data.id ?? "(no id)"} – validation failed:`,
        parseResult.error.flatten().fieldErrors,
      );
      counter.errored++;
      report[featureType] = counter;
      continue;
    }

    // Step c: content filter
    const parsedFeature = parseResult.data;
    const props = parsedFeature.properties as {
      content_status?: string;
      publishable: boolean;
    };

    if (!passesContentFilter(props)) {
      counter.skipped_filter++;
      report[featureType] = counter;
      continue;
    }

    // Enqueue for upsert
    switch (featureType) {
      case "location_candidate":
        validLocationCandidates.push(
          parsedFeature as LocationCandidateFeature,
        );
        break;
      case "quest_definition":
        validQuestDefinitions.push(parsedFeature as QuestDefinitionFeature);
        break;
      case "enemy_encounter":
        validEnemyEncounters.push(parsedFeature as EnemyEncounterFeature);
        break;
      case "navigation_challenge":
        validNavigationChallenges.push(parsedFeature as NavigationChallengeFeature);
        break;
      default:
        // quest_timer is validated but has no separate persistence model.
        counter.skipped_filter++;
        report[featureType] = counter;
        break;
    }
  }

  console.log(
    `   Valid location_candidate : ${validLocationCandidates.length}`,
  );
  console.log(`   Valid quest_definition    : ${validQuestDefinitions.length}`);
  console.log(`   Valid enemy_encounter     : ${validEnemyEncounters.length}`);
  console.log();

  // ── 3. Pass 1 – Upsert WorldObjects ─────────────────────────────────────
  console.log("🔄 Pass 1: Upserting WorldObjects (location_candidate) …");
  for (const feature of validLocationCandidates) {
    await upsertWorldObject(feature, defaults, report);
  }

  console.log("🔄 Pass 1b: Upserting WorldObjects (enemy_encounter) …");
  for (const feature of validEnemyEncounters) {
    await upsertWorldObject(feature, defaults, report);
  }

  // ── 3b. Populate PostGIS geom from lat/lng ────────────────────────────────
  // The Drizzle schema does not declare the geom column (PostGIS type not
  // supported by drizzle-kit), so we update it via raw SQL after each upsert.
  console.log("🗺️  Pass 1c: Populating PostGIS geom column from lat/lng …");
  const geomResult = await db.execute(sql`
    UPDATE world_object
    SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326)
    WHERE lat IS NOT NULL AND lng IS NOT NULL
      AND (geom IS NULL OR NOT ST_Equals(geom, ST_SetSRID(ST_MakePoint(lng, lat), 4326)))
  `);
  console.log(`   geom updated for ${(geomResult as { rowCount?: number }).rowCount ?? "?"} world objects`);

  // ── 4. Pass 2 – Upsert QuestDefinitions ──────────────────────────────────
  console.log("🔄 Pass 2: Upserting QuestDefinitions …");
  for (const feature of validQuestDefinitions) {
    await upsertQuestDefinition(feature, report);
  }

  // ── 5. Pass 3 – Build lookup maps ─────────────────────────────────────────
  console.log("🔍 Pass 3: Building lookup maps …");
  const { worldObjectByExternalId, questDefByExternalId } =
    await buildLookupMaps();
  console.log(
    `   WorldObjects in DB : ${worldObjectByExternalId.size}`,
  );
  console.log(
    `   QuestDefs in DB    : ${questDefByExternalId.size}`,
  );

  // ── 6. Pass 4 – Upsert QuestSteps ────────────────────────────────────────
  console.log("🔄 Pass 4: Upserting QuestSteps from quest_step_refs …");
  await upsertQuestSteps(
    validLocationCandidates,
    questDefByExternalId,
    report,
  );

  console.log("🧭 Pass 4b: Upserting compound-step waypoints …");
  const navigationTargets = new Map(validNavigationChallenges.map((feature) => [
    feature.properties.navigation_id,
    (feature.properties.checkpoint_candidate_ids as string[] | undefined) ?? [],
  ]));
  navigationTargets.set("M-D1-03", [
    "place_day_1_piazza_navona", "place_day_1_fontana_del_nettuno", "place_day_1_fontana_del_moro",
  ]);
  for (const [targetRef, targets] of navigationTargets) {
    const [step] = await db.select({ id: questSteps.id }).from(questSteps).where(eq(questSteps.targetRef, targetRef));
    if (!step) continue;
    for (const [index, waypoint] of targets.entries()) {
      await db.insert(questStepWaypoints).values({ questStepId: step.id, sequence: index + 1, targetRef: waypoint })
        .onConflictDoUpdate({ target: [questStepWaypoints.questStepId, questStepWaypoints.sequence], set: { targetRef: waypoint } });
    }
  }

  // ── 7. Pass 5 – Upsert QuestStations ─────────────────────────────────────
  console.log("🔄 Pass 5: Upserting QuestStations from quest_stations …");
  await upsertQuestStations(
    validLocationCandidates,
    worldObjectByExternalId,
    questDefByExternalId,
    report,
  );

  // ── 8. Upsert production store catalogues ────────────────────────────────
  console.log("🏺 Pass 6: Upserting production store catalogues …");
  await upsertStoreCatalogs(worldObjectByExternalId);

  // ── 9. Print report ───────────────────────────────────────────────────────
  printReport(report, totalRead, Date.now() - startMs);
  console.log("✅ Seed complete.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
