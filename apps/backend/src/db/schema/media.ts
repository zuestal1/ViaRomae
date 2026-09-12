import {
  pgTable,
  uuid,
  pgEnum,
  integer,
  timestamp,
  text,
  jsonb,
  varchar,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { teams } from "./player.js";
import { questRuns } from "./quest.js";
import { accounts } from "./account.js";

export const mediaStatusEnum = pgEnum("media_status", [
  "UPLOADING",
  "RECEIVED",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
]);

export const mediaSubmissions = pgTable("media_submission", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  questRunId: uuid("quest_run_id")
    .notNull()
    .references(() => questRuns.id),
  /** Exact UPLOAD_MEDIA objective this submission belongs to. */
  stepId: varchar("step_id", { length: 64 }).notNull(),
  objectKey: text("object_key").notNull(),
  mimeType: varchar("mime_type", { length: 128 }).notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  status: mediaStatusEnum("status").notNull().default("UPLOADING"),
  submittedAt: timestamp("submitted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const reviewDecisions = pgTable("review_decision", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id")
    .notNull()
    .references(() => mediaSubmissions.id),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => accounts.id),
  score: integer("score").notNull(),
  criteria: jsonb("criteria").$type<{ taskLocation: number; storyRoles: number; creativity: number; execution: number }>(),
  reason: text("reason"),
  decidedAt: timestamp("decided_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  uniqueIndex("review_decision_submission_unique").on(table.submissionId),
]);

export const gmCommandTypeEnum = pgEnum("gm_command_type", [
  "QUEST_RESET",
  "QUEST_STEP_SKIP",
  "HP_OVERRIDE",
  "LOCATION_OVERRIDE",
  "CURRENCY_CORRECTION",
  "ITEM_GRANT",
  "EVENT_CONTROL",
]);

export const auditEvents = pgTable("audit_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => accounts.id),
  action: varchar("action", { length: 64 }).notNull(),
  targetRefs: text("target_refs"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const eventLifecycleStateEnum = pgEnum("event_lifecycle_state", [
  "NOT_STARTED",
  "ACTIVE",
  "PAUSED",
  "ENDED",
]);

export const eventState = pgTable("event_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  state: eventLifecycleStateEnum("state").notNull().default("NOT_STARTED"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  leaderboardFrozen: boolean("leaderboard_frozen").notNull().default(false),
  metadata: jsonb("metadata"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
