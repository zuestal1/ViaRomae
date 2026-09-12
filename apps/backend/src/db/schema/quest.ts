import {
  pgTable,
  uuid,
  varchar,
  pgEnum,
  timestamp,
  integer,
  text,
  boolean,
  unique,
  uniqueIndex,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { players, teams } from "./player.js";
import { worldObjects } from "./world.js";

// ── Enums ──────────────────────────────────────────────────────────────────────

export const questTypeEnum = pgEnum("quest_type", [
  "REGULAR",
  "HIDDEN",
  "LONG_TERM",
  "MEDIA",
]);

export const questRunStateEnum = pgEnum("quest_run_state", [
  "ACTIVE",
  "PENDING_REVIEW",
  "COMPLETED",
  "FAILED",
]);

/**
 * Flow phase of a quest step (maps directly to GeoJSON `flow_phase` values).
 *
 * DISCOVER        → NPC / location appears on the map for the first time
 * DIALOGUE        → conversation / offer screen opens
 * ACCEPT          → team explicitly accepts the quest
 * OBJECTIVE       → playable objectives (travel, answer, fight …)
 * BONUS_OBJECTIVE → optional objective that awards a bonus
 * COMPLETE        → handover / completion confirmation
 */
export const flowPhaseEnum = pgEnum("flow_phase", [
  "DISCOVER",
  "DIALOGUE",
  "ACCEPT",
  "OBJECTIVE",
  "BONUS_OBJECTIVE",
  "COMPLETE",
]);

/**
 * The concrete action the player must perform for a step.
 * Maps to the GeoJSON `step_action_type` values used in v0.8.
 */
export const stepActionTypeEnum = pgEnum("step_action_type", [
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
  // Catch-all for future action types introduced before a migration.
  "OTHER",
]);

export const classUnlockKindEnum = pgEnum("class_unlock_kind", [
  "OPTIONAL_ANSWER", "HINT", "BONUS_OBJECTIVE", "SIDE_QUEST", "HIDDEN_QUEST_TRIGGER",
]);

export const masterfulEyeSubjectEnum = pgEnum("masterful_eye_subject", [
  "ART", "FOUNTAIN", "CHURCH", "STATUE", "ARCHITECTURE",
]);

// ── QuestDefinition ───────────────────────────────────────────────────────────

/**
 * Seeded from GeoJSON `quest_definition` features.
 * `external_id` is the GeoJSON quest_id (e.g. "D1-Q09").
 */
export const questDefinitions = pgTable("quest_definition", {
  id: uuid("id").primaryKey().defaultRandom(),

  /**
   * Natural key from the GeoJSON Feature.id field (e.g. "quest:D1-Q01")
   * or the properties.quest_id value when used as a FK target.
   * Used for idempotent upsert.
   */
  externalId: varchar("external_id", { length: 64 }).unique().notNull(),

  title: varchar("title", { length: 128 }).notNull(),
  type: questTypeEnum("type").notNull(),

  /** Which game day this quest belongs to (e.g. "DAY_1", "DAY_2"). */
  day: varchar("day", { length: 16 }),

  /**
   * Serialised JSON blob of additional GeoJSON properties
   * (story_conflict, dramatic_arc, ordered_candidate_ids, …).
   */
  contentJson: text("content_json").notNull().default("{}"),

  /** Explicit opt-in: completed quests are not repeatable by default. */
  repeatable: boolean("repeatable").notNull().default(false),
  /** Minimum time after completion before a repeatable quest can be accepted. */
  repeatCooldownSeconds: integer("repeat_cooldown_seconds"),
  /** Canonical GDD/Quest-Master metadata, including exact rewards and slots. */
  authoredContent: jsonb("authored_content").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  check("quest_definition_repeat_cooldown_nonnegative", sql`${table.repeatCooldownSeconds} IS NULL OR ${table.repeatCooldownSeconds} >= 0`),
]);

// ── QuestRun ──────────────────────────────────────────────────────────────────

export const questRuns = pgTable("quest_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  questDefinitionId: uuid("quest_definition_id")
    .notNull()
    .references(() => questDefinitions.id),
  state: questRunStateEnum("state").notNull().default("ACTIVE"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Epic 9: When the quest was accepted (for QUEST_RESET functionality) */
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  /** Set when state transitions to COMPLETED or FAILED. */
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** Persisted dialogue/timer/branch state; survives reconnects and restarts. */
  runtimeState: jsonb("runtime_state").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  /** Last line of defence in addition to acceptQuest's transactional team lock. */
  uniqueIndex("quest_run_team_definition_open_unique")
    .on(table.teamId, table.questDefinitionId)
    .where(sql`${table.state} IN ('ACTIVE', 'PENDING_REVIEW')`),
]);

// ── ObjectiveProgress ─────────────────────────────────────────────────────────

export const objectiveProgress = pgTable("objective_progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  questRunId: uuid("quest_run_id")
    .notNull()
    .references(() => questRuns.id, { onDelete: "cascade" }),
  objectiveId: varchar("objective_id", { length: 64 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("PENDING"),
  progressCount: integer("progress_count").notNull().default(0),
},
(table) => [
  /** Unique per (quest_run, objective) so ON CONFLICT upserts work correctly. */
  unique("uq_objective_progress_run_obj").on(
    table.questRunId,
    table.objectiveId,
  ),
]);

// ── QuestStep ─────────────────────────────────────────────────────────────────

/**
 * A single step within a QuestDefinition.
 * Seeded from the `quest_step_refs` arrays inside GeoJSON `location_candidate`
 * features; `step_id` acts as the idempotent natural key.
 *
 * A step's location is referenced via `targetRef` (a WorldObject.externalId or
 * QuestDefinition.externalId string), not a hard FK, because some target types
 * are resolved at runtime.
 */
export const questSteps = pgTable("quest_step", {
  id: uuid("id").primaryKey().defaultRandom(),

  questDefinitionId: uuid("quest_definition_id")
    .notNull()
    .references(() => questDefinitions.id, { onDelete: "cascade" }),

  /**
   * External step identifier from GeoJSON (e.g. "D1-Q09-S05").
   * Unique across the entire dataset.
   */
  stepId: varchar("step_id", { length: 64 }).unique().notNull(),

  /** Position of this step within its quest (1-based). */
  sequence: integer("sequence").notNull(),

  flowPhase: flowPhaseEnum("flow_phase").notNull(),

  /**
   * The concrete action required.
   * Unknown future values are stored as "OTHER".
   */
  stepActionType: stepActionTypeEnum("step_action_type").notNull(),

  /**
   * High-level category:
   *   FLOW_ACTION → structural step (DISCOVER, ACCEPT …); no score impact
   *   OBJECTIVE   → scored / progressive step
   */
  stepCategory: varchar("step_category", { length: 32 }).notNull(),

  /**
   * GDD objective type (e.g. "REACH_LOCATION", "SUBMIT_ANSWER").
   * Null for pure flow actions.
   */
  gddObjectiveType: varchar("gdd_objective_type", { length: 64 }),

  /**
   * Opaque string reference to the target entity:
   *   - WorldObject.externalId  (e.g. "place_day_1_acquedotto_vergine")
   *   - QuestDefinition.externalId (e.g. "H-D1-02")
   *   - NPC / puzzle / item ref (e.g. "npc_rattus_virgo", "PZ-D1-Q09")
   */
  targetRef: varchar("target_ref", { length: 128 }).notNull(),

  /** Whether completing this step is mandatory for quest completion. */
  required: boolean("required").notNull().default(true),
  /** Player copy, validation data and UI metadata from Questablauf/Rätsel. */
  authoredContent: jsonb("authored_content").$type<Record<string, unknown>>().notNull().default({}),
});

/** Ordered, server-authoritative locations belonging to a compound location step. */
export const questStepWaypoints = pgTable("quest_step_waypoint", {
  id: uuid("id").primaryKey().defaultRandom(),
  questStepId: uuid("quest_step_id").notNull().references(() => questSteps.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  targetRef: varchar("target_ref", { length: 128 }).notNull(),
}, (table) => [unique("uq_quest_step_waypoint_sequence").on(table.questStepId, table.sequence)]);

/** Each waypoint is recorded once per run instead of collapsing a route to one counter. */
export const questWaypointProgress = pgTable("quest_waypoint_progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  questRunId: uuid("quest_run_id").notNull().references(() => questRuns.id, { onDelete: "cascade" }),
  waypointId: uuid("waypoint_id").notNull().references(() => questStepWaypoints.id, { onDelete: "cascade" }),
  visitedAt: timestamp("visited_at", { withTimezone: true }).notNull().defaultNow(),
  visitedByPlayerId: uuid("visited_by_player_id").notNull().references(() => players.id),
}, (table) => [unique("uq_quest_waypoint_progress_run_waypoint").on(table.questRunId, table.waypointId)]);

// ── QuestStation ──────────────────────────────────────────────────────────────

/**
 * A spatial puzzle station at a WorldObject location within a quest.
 * Seeded from the `quest_stations` arrays inside GeoJSON `location_candidate`
 * features.
 *
 * One WorldObject can host stations for multiple different quests;
 * the composite (worldObjectId, questDefinitionId, sequence) is the natural key.
 */
export const questStations = pgTable("quest_station", {
  id: uuid("id").primaryKey().defaultRandom(),

  worldObjectId: uuid("world_object_id")
    .notNull()
    .references(() => worldObjects.id, { onDelete: "cascade" }),

  questDefinitionId: uuid("quest_definition_id")
    .notNull()
    .references(() => questDefinitions.id, { onDelete: "cascade" }),

  /**
   * Position of this station within the quest's ordered location chain.
   * Corresponds to the GeoJSON `quest_station.sequence` field.
   */
  sequence: integer("sequence").notNull(),

  /**
   * Role of this station in the quest narrative.
   * E.g. "START / ERSTER HINWEIS", "ZWISCHENSTATION", "ABSCHLUSS".
   */
  role: varchar("role", { length: 64 }).notNull(),

  /** What players should observe at this location. */
  observableEvidence: text("observable_evidence"),

  /** The question players must answer at this station. */
  locationQuestion: text("location_question"),

  /** Expected / model answer. */
  expectedAnswer: text("expected_answer"),

  /**
   * GM fallback note if the location is inaccessible on the day
   * (e.g. maintenance, closures).
   */
  accessFallbackNote: text("access_fallback_note"),

  /**
   * Optional name of the enemy encounter triggered here.
   * Matches enemy_encounter.properties.name in the GeoJSON.
   */
  enemyHook: varchar("enemy_hook", { length: 128 }),
},
(table) => [
  /**
   * Natural composite key: one WorldObject can host exactly one station
   * per (quest, sequence) combination. Used for idempotent ON CONFLICT upserts.
   */
  unique("uq_quest_station_wo_qd_seq").on(
    table.worldObjectId,
    table.questDefinitionId,
    table.sequence,
  ),
]);

/** Optional, explicitly class-gated content. Main objectives never belong here. */
export const questClassUnlocks = pgTable("quest_class_unlock", {
  id: uuid("id").primaryKey().defaultRandom(),
  questDefinitionId: uuid("quest_definition_id").notNull()
    .references(() => questDefinitions.id, { onDelete: "cascade" }),
  worldObjectId: uuid("world_object_id").notNull()
    .references(() => worldObjects.id, { onDelete: "cascade" }),
  nodeId: varchar("node_id", { length: 64 }).notNull(),
  optionId: varchar("option_id", { length: 64 }).notNull(),
  kind: classUnlockKindEnum("kind").notNull(),
  requiredClass: varchar("required_class", { length: 32 }).notNull(),
  subject: masterfulEyeSubjectEnum("subject"),
  text: text("text").notNull(),
  effectJson: text("effect_json").notNull().default("{}"),
  /** Kept for defensive DB/service validation; class-gated rows must be false. */
  required: boolean("required").notNull().default(false),
  bonusGloryPercent: integer("bonus_glory_percent").notNull().default(0),
  bonusDenariiPercent: integer("bonus_denarii_percent").notNull().default(0),
}, (table) => [
  unique("uq_quest_class_unlock_option").on(table.questDefinitionId, table.nodeId, table.optionId),
]);

/** One binding team decision per run and dialogue node. */
export const questDialogueDecisions = pgTable("quest_dialogue_decision", {
  id: uuid("id").primaryKey().defaultRandom(),
  questRunId: uuid("quest_run_id").notNull()
    .references(() => questRuns.id, { onDelete: "cascade" }),
  nodeId: varchar("node_id", { length: 64 }).notNull(),
  optionId: varchar("option_id", { length: 64 }).notNull(),
  chosenByPlayerId: uuid("chosen_by_player_id").notNull()
    .references(() => players.id),
  chosenAt: timestamp("chosen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("uq_quest_dialogue_decision_run_node").on(table.questRunId, table.nodeId)]);
