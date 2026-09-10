/**
 * Combat Contracts – shared Zod schemas for Epic 6 Combat System.
 */

import { z } from "zod";

// ── Enums ─────────────────────────────────────────────────────────────────────

export const CombatTypeSchema = z.enum(["PVE", "PVP", "BOSS"]);
export type CombatType = z.infer<typeof CombatTypeSchema>;

export const CombatStateSchema = z.enum([
  "INITIALIZING",
  "AWAITING_ACTIONS",
  "LOCKED",
  "RESOLVING",
  "COMPLETED",
]);
export type CombatState = z.infer<typeof CombatStateSchema>;

export const ActionTypeSchema = z.enum(["ATTACK", "DEFEND", "SKILL", "FLEE"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const CombatActionOriginSchema = z.enum([
  "PLAYER_SUBMITTED",
  "AUTOMATIC",
  "ENEMY_AI",
]);
export type CombatActionOrigin = z.infer<typeof CombatActionOriginSchema>;

export const EntityTypeSchema = z.enum(["PLAYER", "ENEMY"]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const PvPChallengeStateSchema = z.enum(["WARNING", "ESCAPED", "COMBAT"]);
export type PvPChallengeState = z.infer<typeof PvPChallengeStateSchema>;

// ── Combat Instance ───────────────────────────────────────────────────────────

export const CombatantSchema = z.object({
  id: z.string().uuid(),
  entityType: EntityTypeSchema,
  entityId: z.string().uuid(),
  teamId: z.string().uuid().optional(),
  hpCurrent: z.number(),
  hpMax: z.number(),
  initiative: z.number(),
  name: z.string(),
  isDowned: z.boolean(),
  attack: z.number(),
  defense: z.number(),
});
export type Combatant = z.infer<typeof CombatantSchema>;

export const CombatActionSchema = z.object({
  id: z.string().uuid(),
  roundNumber: z.number(),
  actorId: z.string().uuid(),
  actionType: ActionTypeSchema,
  targetId: z.string().uuid().optional(),
  isLocked: z.boolean(),
  origin: CombatActionOriginSchema,
  damage: z.number().optional(),
  effect: z.string().optional(),
});
export type CombatAction = z.infer<typeof CombatActionSchema>;

export const CombatInstanceSchema = z.object({
  id: z.string().uuid(),
  type: CombatTypeSchema,
  state: CombatStateSchema,
  roundNumber: z.number(),
  startedAt: z.string().datetime(),
  combatants: z.array(CombatantSchema),
  actions: z.array(CombatActionSchema),
});
export type CombatInstance = z.infer<typeof CombatInstanceSchema>;

// ── Combat Log ────────────────────────────────────────────────────────────────

export const CombatLogTypeSchema = z.enum(["ACTION", "DAMAGE", "EFFECT", "STATE"]);
export type CombatLogType = z.infer<typeof CombatLogTypeSchema>;

export const CombatLogSchema = z.object({
  timestamp: z.string().datetime(),
  message: z.string(),
  type: CombatLogTypeSchema,
});
export type CombatLog = z.infer<typeof CombatLogSchema>;

// ── Request Bodies ────────────────────────────────────────────────────────────

export const SubmitActionBodySchema = z.object({
  actionType: ActionTypeSchema,
  targetId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid(),
});
export type SubmitActionBody = z.infer<typeof SubmitActionBodySchema>;

// ── WebSocket Events ──────────────────────────────────────────────────────────

export const CombatStartedEventSchema = z.object({
  event: z.literal("combat:started"),
  data: z.object({
    combatId: z.string().uuid(),
    type: CombatTypeSchema,
    enemyName: z.string().optional(),
    opponentTeamId: z.string().uuid().optional(),
  }),
});
export type CombatStartedEvent = z.infer<typeof CombatStartedEventSchema>;

export const CombatActionSubmittedEventSchema = z.object({
  event: z.literal("combat:action_submitted"),
  data: z.object({
    combatId: z.string().uuid(),
    action: CombatActionSchema,
  }),
});
export type CombatActionSubmittedEvent = z.infer<typeof CombatActionSubmittedEventSchema>;

export const CombatRoundResolvedEventSchema = z.object({
  event: z.literal("combat:round_resolved"),
  data: z.object({
    combatId: z.string().uuid(),
    round: z.number(),
    logs: z.array(CombatLogSchema),
  }),
});
export type CombatRoundResolvedEvent = z.infer<typeof CombatRoundResolvedEventSchema>;

export const CombatCompletedEventSchema = z.object({
  event: z.literal("combat:completed"),
  data: z.object({
    combatId: z.string().uuid(),
    logs: z.array(CombatLogSchema),
  }),
});
export type CombatCompletedEvent = z.infer<typeof CombatCompletedEventSchema>;

export const PvPChallengeStartedEventSchema = z.object({
  event: z.literal("pvp:challenge_started"),
  data: z.object({
    challengeId: z.string().uuid(),
    role: z.enum(["attacker", "defender"]),
    opponentTeamId: z.string().uuid(),
    expiresAt: z.string().datetime(),
  }),
});
export type PvPChallengeStartedEvent = z.infer<typeof PvPChallengeStartedEventSchema>;

export const PvPChallengeEscapedEventSchema = z.object({
  event: z.literal("pvp:challenge_escaped"),
  data: z.object({
    challengeId: z.string().uuid(),
    reason: z.string().optional(),
  }),
});
export type PvPChallengeEscapedEvent = z.infer<typeof PvPChallengeEscapedEventSchema>;

export const TeamWipedEventSchema = z.object({
  event: z.literal("team:wiped"),
  data: z.object({
    message: z.string(),
  }),
});
export type TeamWipedEvent = z.infer<typeof TeamWipedEventSchema>;

// ── World Boss Schemas ────────────────────────────────────────────────────────

export const BossJoinRequestBodySchema = z.object({
  worldObjectId: z.string().uuid(),
  playerId: z.string().uuid(),
});
export type BossJoinRequestBody = z.infer<typeof BossJoinRequestBodySchema>;

export const BossGlobalActionBodySchema = z.object({
  actionType: z.enum(["APPLAUD", "CHEER", "COORDINATED_ATTACK"]),
  teamId: z.string().uuid(),
});
export type BossGlobalActionBody = z.infer<typeof BossGlobalActionBodySchema>;

export const BossCombatStatusSchema = z.object({
  combatId: z.string().uuid(),
  bossName: z.string(),
  bossHpCurrent: z.number(),
  bossHpMax: z.number(),
  participatingTeams: z.number(),
  roundNumber: z.number(),
  state: CombatStateSchema,
});
export type BossCombatStatus = z.infer<typeof BossCombatStatusSchema>;

// ── Boss WebSocket Events ─────────────────────────────────────────────────────

export const BossJoinedEventSchema = z.object({
  event: z.literal("boss:team_joined"),
  data: z.object({
    combatId: z.string().uuid(),
    teamId: z.string().uuid(),
    teamCount: z.number(),
  }),
});
export type BossJoinedEvent = z.infer<typeof BossJoinedEventSchema>;

export const BossHealthUpdatedEventSchema = z.object({
  event: z.literal("boss:health_updated"),
  data: z.object({
    combatId: z.string().uuid(),
    hpCurrent: z.number(),
    hpMax: z.number(),
    percentRemaining: z.number(),
  }),
});
export type BossHealthUpdatedEvent = z.infer<typeof BossHealthUpdatedEventSchema>;

export const BossDefeatedEventSchema = z.object({
  event: z.literal("boss:defeated"),
  data: z.object({
    combatId: z.string().uuid(),
    bossName: z.string(),
    participatingTeams: z.array(z.string().uuid()),
  }),
});
export type BossDefeatedEvent = z.infer<typeof BossDefeatedEventSchema>;
