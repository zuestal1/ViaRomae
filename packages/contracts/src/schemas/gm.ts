/**
 * GM Operations Schemas – Epic 9
 * Request/response schemas for GM dashboard and operations.
 */

import { z } from "zod";
import { RoleSchema } from "./auth.js";

// ── GM Commands ────────────────────────────────────────────────────────────────

export const GMCommandTypeSchema = z.enum([
  "QUEST_RESET",
  "HP_OVERRIDE",
  "LOCATION_OVERRIDE",
  "CURRENCY_CORRECTION",
  "ITEM_GRANT",
  "EVENT_CONTROL",
]);
export type GMCommandType = z.infer<typeof GMCommandTypeSchema>;

export const ResetQuestBodySchema = z.object({
  questRunId: z.string().uuid(),
});
export type ResetQuestBody = z.infer<typeof ResetQuestBodySchema>;

export const OverrideHPBodySchema = z.object({
  teamId: z.string().uuid(),
  newHP: z.number().int().min(0),
});
export type OverrideHPBody = z.infer<typeof OverrideHPBodySchema>;

export const OverrideLocationBodySchema = z.object({
  playerId: z.string().uuid(),
  lat: z.number(),
  lng: z.number(),
});
export type OverrideLocationBody = z.infer<typeof OverrideLocationBodySchema>;

export const CorrectCurrencyBodySchema = z.object({
  teamId: z.string().uuid(),
  currencyType: z.enum(["FAME", "DENARII"]),
  amount: z.number().int(),
  reason: z.string().min(1),
});
export type CorrectCurrencyBody = z.infer<typeof CorrectCurrencyBodySchema>;

export const CreatePlayerAccountBodySchema = z.object({
  username: z.string().trim().min(2).max(64),
  accessCode: z.string().min(4).max(64),
  teamId: z.string().uuid().optional(),
  newTeamName: z.string().trim().min(2).max(64).optional(),
  playerName: z.string().trim().min(2).max(64).optional(),
}).refine((value) => Boolean(value.teamId) !== Boolean(value.newTeamName), {
  message: "Genau ein bestehendes Team oder ein neuer Teamname ist erforderlich.",
});
export type CreatePlayerAccountBody = z.infer<typeof CreatePlayerAccountBodySchema>;

export const CreatedPlayerAccountSchema = z.object({
  account: z.object({ id: z.string().uuid(), username: z.string(), role: RoleSchema }),
  player: z.object({ id: z.string().uuid(), teamId: z.string().uuid(), playerName: z.string() }),
  team: z.object({ id: z.string().uuid(), name: z.string() }),
});
export type CreatedPlayerAccount = z.infer<typeof CreatedPlayerAccountSchema>;

export const GMTeamOptionSchema = z.object({ id: z.string().uuid(), name: z.string() });
export type GMTeamOption = z.infer<typeof GMTeamOptionSchema>;

export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid(),
  action: z.string(),
  targetRefs: z.string().nullable(),
  payload: z.unknown(),
  createdAt: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

// ── Event Lifecycle ────────────────────────────────────────────────────────────

export const EventLifecycleStateSchema = z.enum([
  "NOT_STARTED",
  "ACTIVE",
  "PAUSED",
  "ENDED",
]);
export type EventLifecycleState = z.infer<typeof EventLifecycleStateSchema>;

export const EventStateSchema = z.object({
  id: z.string().uuid(),
  state: EventLifecycleStateSchema,
  startedAt: z.string().datetime().nullable(),
  pausedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  leaderboardFrozen: z.boolean(),
  metadata: z.unknown(),
  updatedAt: z.string().datetime(),
});
export type EventState = z.infer<typeof EventStateSchema>;

export const TeamLeaderboardEntrySchema = z.object({
  teamId: z.string().uuid(),
  teamName: z.string(),
  totalFame: z.number(),
  totalDenarii: z.number(),
  questsCompleted: z.number(),
  rank: z.number(),
});
export type TeamLeaderboardEntry = z.infer<typeof TeamLeaderboardEntrySchema>;

export const PlayerLeaderboardEntrySchema = TeamLeaderboardEntrySchema.omit({ teamId: true });
export type PlayerLeaderboardEntry = z.infer<typeof PlayerLeaderboardEntrySchema>;

export const RuntimeEventStateSchema = z.object({
  state: EventLifecycleStateSchema,
  currentDay: z.union([z.literal(1), z.literal(2)]),
  leaderboardFrozen: z.boolean(),
});
export type RuntimeEventState = z.infer<typeof RuntimeEventStateSchema>;

export const EventSummarySchema = z.object({
  totalTeams: z.number(),
  activeTeams: z.number(),
  totalQuestsCompleted: z.number(),
  totalFameAwarded: z.number(),
  totalDenariiAwarded: z.number(),
  eventDurationMinutes: z.number(),
  topTeam: TeamLeaderboardEntrySchema.nullable(),
});
export type EventSummary = z.infer<typeof EventSummarySchema>;

export const ToggleLeaderboardFreezeBodySchema = z.object({
  freeze: z.boolean(),
});
export type ToggleLeaderboardFreezeBody = z.infer<
  typeof ToggleLeaderboardFreezeBodySchema
>;

// ── Seed Control ───────────────────────────────────────────────────────────────

export const SeedReportSchema = z.object({
  totalFeaturesRead: z.number(),
  locationCandidatesImported: z.number(),
  enemyEncountersImported: z.number(),
  questDefinitionsImported: z.number(),
  skippedFiltered: z.number(),
  errors: z.number(),
  elapsedMs: z.number(),
});
export type SeedReport = z.infer<typeof SeedReportSchema>;

// ── Live Dashboard Data ────────────────────────────────────────────────────────

export const PlayerPositionSchema = z.object({
  playerId: z.string().uuid(),
  playerName: z.string(),
  teamId: z.string().uuid(),
  teamName: z.string(),
  lat: z.number(),
  lng: z.number(),
  accuracy: z.number(),
  lastUpdate: z.string().datetime(),
});
export type PlayerPosition = z.infer<typeof PlayerPositionSchema>;

export const TeamStatusSchema = z.object({
  teamId: z.string().uuid(),
  teamName: z.string(),
  hp: z.number(),
  fame: z.number(),
  denarii: z.number(),
  activeQuestCount: z.number(),
  isActive: z.boolean(),
});
export type TeamStatus = z.infer<typeof TeamStatusSchema>;

export const WorldObjectMarkerSchema = z.object({
  id: z.string().uuid(),
  externalId: z.string(),
  type: z.enum(["LOCATION", "ENEMY", "NPC", "STORE", "BOSS", "SAFE_ZONE"]),
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  cluster: z.string().nullable(),
  discoveryRadiusM: z.number(),
  interactionRadiusM: z.number(),
  publishable: z.boolean(),
});
export type WorldObjectMarker = z.infer<typeof WorldObjectMarkerSchema>;

// ── Media Inbox (extended for GM) ──────────────────────────────────────────────

export const MediaSubmissionWithTeamSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  teamName: z.string(),
  questRunId: z.string().uuid(),
  objectKey: z.string(),
  mimeType: z.string(),
  fileSizeBytes: z.number().int().nonnegative(),
  previewUrl: z.string().url().optional(),
  status: z.enum(["UPLOADING", "RECEIVED", "IN_REVIEW", "APPROVED", "REJECTED"]),
  submittedAt: z.string().datetime(),
});
export type MediaSubmissionWithTeam = z.infer<typeof MediaSubmissionWithTeamSchema>;

// ── WebSocket Events (GM-specific) ─────────────────────────────────────────────

export const GMPlayerLocationUpdateEventSchema = z.object({
  event: z.literal("gm:player_location_update"),
  playerId: z.string().uuid(),
  playerName: z.string(),
  teamId: z.string().uuid(),
  teamName: z.string(),
  lat: z.number(),
  lng: z.number(),
  accuracy: z.number(),
  timestamp: z.string().datetime(),
});
export type GMPlayerLocationUpdateEvent = z.infer<
  typeof GMPlayerLocationUpdateEventSchema
>;

export const GMTeamStatusUpdateEventSchema = z.object({
  event: z.literal("gm:team_status_update"),
  teamId: z.string().uuid(),
  teamName: z.string(),
  hp: z.number(),
  fame: z.number(),
  denarii: z.number(),
  timestamp: z.string().datetime(),
});
export type GMTeamStatusUpdateEvent = z.infer<typeof GMTeamStatusUpdateEventSchema>;
