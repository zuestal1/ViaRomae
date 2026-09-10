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

// ── Status effects & cooldowns ──────────────────────────────────────

export const StatusEffectPolaritySchema = z.enum(["BUFF", "DEBUFF", "NEUTRAL"]);
export const StatusEffectTagSchema = z.enum([
  "CONTROL",
  "DAMAGE_TAKEN",
  "DAMAGE_DEALT",
  "DEF",
  "INIT",
  "SHIELD",
]);
export const StatusEffectDurationTypeSchema = z.enum([
  "ROUNDS",
  "TRIGGERS",
  "PERMANENT",
]);
export const StatusEffectStackPolicySchema = z.enum([
  "NONE",
  "REFRESH",
  "REPLACE_STRONGER",
  "STACK",
]);
export const StatusEffectPersistenceScopeSchema = z.enum([
  "COMBAT",
  "ENCOUNTER",
  "PLAYER",
]);
export const StatusModifierTypeSchema = z.enum([
  "DAMAGE_DEALT_PERCENT",
  "DAMAGE_TAKEN_PERCENT",
  "DEF_PERCENT",
  "INIT_PERCENT",
  "SHIELD",
]);

export type StatusEffectTag = z.infer<typeof StatusEffectTagSchema>;
export type StatusEffectStackPolicy = z.infer<typeof StatusEffectStackPolicySchema>;

export const StatusEffectModifierSchema = z.object({
  type: StatusModifierTypeSchema,
  value: z.number(),
});

export const StatusEffectTriggerSchema = z.object({
  trigger: z.string().min(1),
  effectId: z.string().min(1),
  chance: z.number().min(0).max(1).default(1),
  maxTriggers: z.number().int().positive().optional(),
});

/** Static, data-driven status-effect catalogue entry. */
export const StatusEffectDefinitionSchema = z.object({
  id: z.string().min(1),
  polarity: StatusEffectPolaritySchema,
  tags: z.array(StatusEffectTagSchema),
  durationType: StatusEffectDurationTypeSchema,
  baseDuration: z.number().int().nonnegative(),
  stackPolicy: StatusEffectStackPolicySchema.default("REPLACE_STRONGER"),
  maxStacks: z.number().int().positive(),
  modifiers: z.array(StatusEffectModifierSchema),
  triggerEffects: z.array(StatusEffectTriggerSchema),
  removable: z.boolean(),
  dispelTags: z.array(StatusEffectTagSchema),
  persistenceScope: StatusEffectPersistenceScopeSchema,
});
export type StatusEffectDefinition = z.infer<typeof StatusEffectDefinitionSchema>;

/** A persisted application of a definition to one combatant. */
export const StatusEffectInstanceSchema = z.object({
  id: z.string().uuid(),
  effectId: z.string().min(1),
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  appliedRound: z.number().int().nonnegative(),
  expiresAfterRound: z.number().int().nonnegative().nullable(),
  stacks: z.number().int().positive(),
  magnitudeOverrides: z.record(z.number()).optional(),
  remainingTriggers: z.number().int().nonnegative().optional(),
  remainingDurationRounds: z.number().int().nonnegative().nullable(),
  shieldRemaining: z.number().nonnegative().optional(),
});
export type StatusEffectInstance = z.infer<typeof StatusEffectInstanceSchema>;

export const AbilityCooldownSchema = z.object({
  id: z.string().uuid(),
  combatantId: z.string().uuid(),
  abilityId: z.string().min(1),
  activatedRound: z.number().int().nonnegative(),
  readyAfterRound: z.number().int().nonnegative(),
  remainingRounds: z.number().int().nonnegative(),
  isReady: z.boolean(),
  deactivationReason: z.string().min(1).optional(),
});
export type AbilityCooldown = z.infer<typeof AbilityCooldownSchema>;

/** GDD global modifier/shield limits; values are percentage points. */
export const COMBAT_EFFECT_CAPS = {
  DAMAGE_DEALT_PERCENT: { min: -60, max: 100 },
  DAMAGE_TAKEN_PERCENT: { min: -60, max: 100 },
  DEF_PERCENT: { min: -60, max: 100 },
  SHIELD_MAX_HP_PERCENT: 50,
} as const;

export const FUERBITTE_DISPEL_PRIORITY: readonly StatusEffectTag[] = [
  "CONTROL", "DAMAGE_TAKEN", "DAMAGE_DEALT", "DEF", "INIT",
];

/** Rounds are inclusive: a two-round effect applied in round 3 expires after 4. */
export function getExpiresAfterRound(appliedRound: number, durationRounds: number): number {
  if (!Number.isInteger(durationRounds) || durationRounds <= 0) {
    throw new RangeError("durationRounds must be a positive integer");
  }
  return appliedRound + durationRounds - 1;
}

export function getRemainingRounds(expiresAfterRound: number | null, currentRound: number): number | null {
  return expiresAfterRound === null ? null : Math.max(0, expiresAfterRound - currentRound + 1);
}

export function clampCombatModifier(
  type: "DAMAGE_DEALT_PERCENT" | "DAMAGE_TAKEN_PERCENT" | "DEF_PERCENT",
  total: number,
): number {
  const cap = COMBAT_EFFECT_CAPS[type];
  return Math.min(cap.max, Math.max(cap.min, total));
}

export function clampShield(totalShield: number, maxHp: number): number {
  return Math.max(0, Math.min(totalShield, maxHp * COMBAT_EFFECT_CAPS.SHIELD_MAX_HP_PERCENT / 100));
}

export type StatusEffectStackResolution =
  | { action: "IGNORED" }
  | { action: "UPDATED"; stacks: number; expiresAfterRound: number | null };

/**
 * Resolves a second application of the same effect ID. Different IDs never
 * enter this function and therefore combine independently up to global caps.
 */
export function resolveStatusEffectStack(options: {
  policy?: StatusEffectStackPolicy;
  currentStacks: number;
  maxStacks: number;
  currentMagnitude: number;
  incomingMagnitude: number;
  currentExpiresAfterRound: number | null;
  incomingExpiresAfterRound: number | null;
}): StatusEffectStackResolution {
  const policy = options.policy ?? "REPLACE_STRONGER";
  if (policy === "NONE") return { action: "IGNORED" };
  if (policy === "REPLACE_STRONGER" && options.incomingMagnitude <= options.currentMagnitude) {
    return { action: "IGNORED" };
  }
  if (policy === "STACK") {
    return {
      action: "UPDATED",
      stacks: Math.min(options.maxStacks, options.currentStacks + 1),
      expiresAfterRound: options.incomingExpiresAfterRound,
    };
  }
  return {
    action: "UPDATED",
    stacks: policy === "REFRESH" ? options.currentStacks : 1,
    expiresAfterRound: options.incomingExpiresAfterRound,
  };
}

/** Selects the removable debuff Fürbitte removes, with oldest as final tie-breaker. */
export function selectFuerbitteDispel<T extends {
  polarity: "BUFF" | "DEBUFF" | "NEUTRAL";
  tags: readonly StatusEffectTag[];
  removable: boolean;
  appliedRound: number;
}>(effects: readonly T[]): T | undefined {
  return effects.filter((effect) => effect.polarity === "DEBUFF" && effect.removable)
    .sort((a, b) => {
      const rank = (effect: T) => {
        const ranks = effect.tags.map((tag) => FUERBITTE_DISPEL_PRIORITY.indexOf(tag))
          .filter((value) => value >= 0);
        return ranks.length === 0 ? FUERBITTE_DISPEL_PRIORITY.length : Math.min(...ranks);
      };
      return rank(a) - rank(b) || a.appliedRound - b.appliedRound;
    })[0];
}

// ── Combat Instance ───────────────────────────────────────────────────────────

export const CombatantSchema = z.object({
  id: z.string().uuid(),
  entityType: EntityTypeSchema,
  entityId: z.string().uuid(),
  teamId: z.string().uuid().optional(),
  hpCurrent: z.number(),
  hpMax: z.number(),
  atk: z.number(),
  def: z.number(),
  initiative: z.number(),
  name: z.string(),
  isDowned: z.boolean(),
  activeEffects: z.array(StatusEffectInstanceSchema),
  shield: z.number().nonnegative(),
  cooldowns: z.array(AbilityCooldownSchema),
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
    combatants: z.array(CombatantSchema),
  }),
});
export type CombatRoundResolvedEvent = z.infer<typeof CombatRoundResolvedEventSchema>;

export const CombatCompletedEventSchema = z.object({
  event: z.literal("combat:completed"),
  data: z.object({
    combatId: z.string().uuid(),
    logs: z.array(CombatLogSchema),
    combatants: z.array(CombatantSchema),
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
