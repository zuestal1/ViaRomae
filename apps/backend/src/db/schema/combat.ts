import {
  pgTable,
  uuid,
  pgEnum,
  integer,
  timestamp,
  boolean,
  varchar,
  jsonb,
  uniqueIndex,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { teams } from "./player.js";

export const combatTypeEnum = pgEnum("combat_type", ["PVE", "PVP", "BOSS"]);
export const combatStateEnum = pgEnum("combat_state", [
  "INITIALIZING",
  "AWAITING_ACTIONS",
  "LOCKED",
  "RESOLVING",
  "COMPLETED",
]);
export const entityTypeEnum = pgEnum("entity_type", ["PLAYER", "ENEMY"]);
export const actionTypeEnum = pgEnum("action_type", [
  "ATTACK",
  "DEFEND",
  "SKILL",
  "FLEE",
]);
export const combatActionOriginEnum = pgEnum("combat_action_origin", [
  "PLAYER_SUBMITTED",
  "AUTOMATIC",
  "ENEMY_AI",
]);
export const pvpChallengeStateEnum = pgEnum("pvp_challenge_state", [
  "WARNING",
  "ESCAPED",
  "COMBAT",
]);
export const statusEffectPolarityEnum = pgEnum("status_effect_polarity", ["BUFF", "DEBUFF", "NEUTRAL"]);
export const statusEffectDurationTypeEnum = pgEnum("status_effect_duration_type", ["ROUNDS", "TRIGGERS", "PERMANENT"]);
export const statusEffectStackPolicyEnum = pgEnum("status_effect_stack_policy", ["NONE", "REFRESH", "REPLACE_STRONGER", "STACK"]);
export const statusEffectPersistenceScopeEnum = pgEnum("status_effect_persistence_scope", ["COMBAT", "ENCOUNTER", "PLAYER"]);

export const combatInstances = pgTable("combat_instance", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: combatTypeEnum("type").notNull(),
  state: combatStateEnum("state").notNull().default("AWAITING_ACTIONS"),
  roundNumber: integer("round_number").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const combatants = pgTable("combatant", {
  id: uuid("id").primaryKey().defaultRandom(),
  combatInstanceId: uuid("combat_instance_id")
    .notNull()
    .references(() => combatInstances.id, { onDelete: "cascade" }),
  entityType: entityTypeEnum("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  teamId: uuid("team_id").references(() => teams.id),
  hpCurrent: integer("hp_current").notNull(),
});

export const combatActions = pgTable("combat_action", {
  id: uuid("id").primaryKey().defaultRandom(),
  combatInstanceId: uuid("combat_instance_id")
    .notNull()
    .references(() => combatInstances.id, { onDelete: "cascade" }),
  roundNumber: integer("round_number").notNull(),
  actorId: uuid("actor_id").notNull(),
  actionType: actionTypeEnum("action_type").notNull(),
  targetId: uuid("target_id"),
  isLocked: boolean("is_locked").notNull().default(false),
  origin: combatActionOriginEnum("origin").notNull().default("PLAYER_SUBMITTED"),
  idempotencyKey: uuid("idempotency_key").notNull().unique(),
  abilityId: varchar("ability_id", { length: 64 }),
}, (table) => [
  uniqueIndex("combat_action_instance_round_actor_unique").on(
    table.combatInstanceId,
    table.roundNumber,
    table.actorId
  ),
]);

/** Initiative snapshots and the single random tie-breaker generated for a round. */
export const combatRoundOrders = pgTable("combat_round_order", {
  id: uuid("id").primaryKey().defaultRandom(),
  combatInstanceId: uuid("combat_instance_id").notNull()
    .references(() => combatInstances.id, { onDelete: "cascade" }),
  roundNumber: integer("round_number").notNull(),
  actorId: uuid("actor_id").notNull(),
  effectiveInitiative: integer("effective_initiative").notNull(),
  equipmentRarityScore: integer("equipment_rarity_score").notNull(),
  roundRandom: integer("round_random").notNull(),
}, (table) => [
  uniqueIndex("combat_round_order_instance_round_actor_unique").on(
    table.combatInstanceId, table.roundNumber, table.actorId,
  ),
]);

/** Immutable request receipts keep retries idempotent after a later replacement. */
export const combatActionSubmissions = pgTable("combat_action_submission", {
  idempotencyKey: uuid("idempotency_key").primaryKey(),
  actionId: uuid("action_id").notNull(),
  combatInstanceId: uuid("combat_instance_id").notNull(),
  roundNumber: integer("round_number").notNull(),
  actorId: uuid("actor_id").notNull(),
  actionType: actionTypeEnum("action_type").notNull(),
  targetId: uuid("target_id"),
  abilityId: varchar("ability_id", { length: 64 }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cooldowns are durable combat state, keyed by fighter and stable ability id. */
export const combatAbilityCooldowns = pgTable("combat_ability_cooldown", {
  combatInstanceId: uuid("combat_instance_id").notNull().references(() => combatInstances.id, { onDelete: "cascade" }),
  combatantId: uuid("combatant_id").notNull().references(() => combatants.id, { onDelete: "cascade" }),
  abilityId: varchar("ability_id", { length: 64 }).notNull(),
  availableAtRound: integer("available_at_round").notNull(),
}, (table) => [uniqueIndex("combat_cooldown_fighter_ability_unique").on(table.combatantId, table.abilityId)]);

/** Timed effects are data-driven snapshots referencing their originating definition. */
export const combatEffects = pgTable("combat_effect", {
  id: uuid("id").primaryKey().defaultRandom(),
  combatInstanceId: uuid("combat_instance_id").notNull().references(() => combatInstances.id, { onDelete: "cascade" }),
  sourceCombatantId: uuid("source_combatant_id").notNull().references(() => combatants.id, { onDelete: "cascade" }),
  targetCombatantId: uuid("target_combatant_id").references(() => combatants.id, { onDelete: "cascade" }),
  abilityId: varchar("ability_id", { length: 64 }).notNull(),
  expiresAtRound: integer("expires_at_round"),
  state: jsonb("state").$type<Record<string, number | boolean>>().notNull().default({}),
});
/** Data-driven status effect catalogue. JSON columns retain ordered GDD payloads. */
export const statusEffectDefinitions = pgTable("status_effect_definition", {
  id: varchar("id", { length: 128 }).primaryKey(),
  polarity: statusEffectPolarityEnum("polarity").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  durationType: statusEffectDurationTypeEnum("duration_type").notNull(),
  baseDuration: integer("base_duration").notNull(),
  stackPolicy: statusEffectStackPolicyEnum("stack_policy").notNull().default("REPLACE_STRONGER"),
  maxStacks: integer("max_stacks").notNull().default(1),
  modifiers: jsonb("modifiers").$type<Array<{ type: string; value: number }>>().notNull().default([]),
  triggerEffects: jsonb("trigger_effects").$type<Array<{
    trigger: string; effectId: string; chance: number; maxTriggers?: number;
  }>>().notNull().default([]),
  removable: boolean("removable").notNull().default(true),
  dispelTags: jsonb("dispel_tags").$type<string[]>().notNull().default([]),
  persistenceScope: statusEffectPersistenceScopeEnum("persistence_scope").notNull().default("COMBAT"),
});

/** Persisted effect application; expiration rounds are inclusive. */
export const statusEffectInstances = pgTable("status_effect_instance", {
  id: uuid("id").primaryKey().defaultRandom(),
  combatInstanceId: uuid("combat_instance_id").notNull()
    .references(() => combatInstances.id, { onDelete: "cascade" }),
  effectId: varchar("effect_id", { length: 128 }).notNull()
    .references(() => statusEffectDefinitions.id),
  sourceId: uuid("source_id").notNull().references(() => combatants.id, { onDelete: "cascade" }),
  targetId: uuid("target_id").notNull().references(() => combatants.id, { onDelete: "cascade" }),
  appliedRound: integer("applied_round").notNull(),
  expiresAfterRound: integer("expires_after_round"),
  stacks: integer("stacks").notNull().default(1),
  magnitudeOverrides: jsonb("magnitude_overrides").$type<Record<string, number>>(),
  remainingTriggers: integer("remaining_triggers"),
  shieldRemaining: integer("shield_remaining"),
}, (table) => [
  index("status_effect_instance_target_idx").on(table.targetId),
  index("status_effect_instance_combat_idx").on(table.combatInstanceId),
]);

/** One durable cooldown clock per combatant and ability. */
export const abilityCooldowns = pgTable("ability_cooldown", {
  id: uuid("id").primaryKey().defaultRandom(),
  combatInstanceId: uuid("combat_instance_id").notNull()
    .references(() => combatInstances.id, { onDelete: "cascade" }),
  combatantId: uuid("combatant_id").notNull()
    .references(() => combatants.id, { onDelete: "cascade" }),
  abilityId: varchar("ability_id", { length: 128 }).notNull(),
  activatedRound: integer("activated_round").notNull(),
  readyAfterRound: integer("ready_after_round").notNull(),
  deactivationReason: varchar("deactivation_reason", { length: 255 }),
}, (table) => [
  uniqueIndex("ability_cooldown_combatant_ability_unique").on(table.combatantId, table.abilityId),
  index("ability_cooldown_combat_idx").on(table.combatInstanceId),
]);

export const pvpChallenges = pgTable("pvp_challenge", {
  id: uuid("id").primaryKey().defaultRandom(),
  attackerTeamId: uuid("attacker_team_id")
    .notNull()
    .references(() => teams.id),
  defenderTeamId: uuid("defender_team_id")
    .notNull()
    .references(() => teams.id),
  state: pvpChallengeStateEnum("state").notNull().default("WARNING"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
