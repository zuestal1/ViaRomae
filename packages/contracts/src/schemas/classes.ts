import { z } from "zod";

export const ClassIdSchema = z.enum(["guard", "cleric", "sculptor", "condottiere"]);
export type ClassId = z.infer<typeof ClassIdSchema>;
export const EquipmentSlotSchema = z.enum(["WEAPON", "CLOTHING", "DEFENSE", "ARTIFACT"]);
export const AbilityTargetSchema = z.enum(["SELF", "ALLY", "ENEMY", "ALL_ACTIVE_ALLIES"]);

export const StatusEffectSchema = z.object({
  id: z.string(), name: z.string(), polarity: z.enum(["POSITIVE", "NEGATIVE"]),
  tags: z.array(z.enum(["CONTROL", "DAMAGE_TAKEN", "DAMAGE_DEALT", "DEF", "INIT"])),
  remainingRounds: z.number().int().nonnegative().optional(),
  remainingTriggers: z.number().int().nonnegative().optional(), stacks: z.number().int().positive(),
});

export const AbilitySchema = z.object({
  id: z.string(), name: z.string(), kind: z.enum(["BASIC", "ACTIVE", "PASSIVE"]),
  targets: z.array(AbilityTargetSchema), cooldownRounds: z.number().int().nonnegative(),
  description: z.string(), disabledReason: z.string().nullable().default(null),
});

export const ClassDefinitionSchema = z.object({
  id: ClassIdSchema, name: z.string(), aliases: z.array(z.string()),
  baseStats: z.object({ maxHP: z.number(), atk: z.number(), def: z.number(), initiative: z.number() }),
  slots: z.array(EquipmentSlotSchema).length(4), abilities: z.array(AbilitySchema).length(4),
});

export const CharacterStateSchema = z.object({
  classId: ClassIdSchema, hpCurrent: z.number().nonnegative(), maxHP: z.number().positive(),
  atk: z.number(), def: z.number(), initiative: z.number(),
  statusEffects: z.array(StatusEffectSchema), cooldowns: z.record(z.number().int().nonnegative()),
  disabledReasons: z.record(z.string()),
});
