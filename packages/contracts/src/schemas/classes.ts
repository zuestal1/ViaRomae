import { z } from "zod";
import { AbilityDefinitionSchema } from "./ability.js";

export const ClassIdSchema = z.enum(["guard", "cleric", "sculptor", "condottiere"]);
export type ClassId = z.infer<typeof ClassIdSchema>;
export const EquipmentSlotSchema = z.enum(["WEAPON", "CLOTHING", "DEFENSE", "ARTIFACT"]);

export const ClassStatusEffectSchema = z.object({
  id: z.string(), name: z.string(), polarity: z.enum(["POSITIVE", "NEGATIVE"]),
  tags: z.array(z.enum(["CONTROL", "DAMAGE_TAKEN", "DAMAGE_DEALT", "DEF", "INIT"])),
  remainingRounds: z.number().int().nonnegative().optional(),
  remainingTriggers: z.number().int().nonnegative().optional(), stacks: z.number().int().positive(),
});

export const ClassDefinitionSchema = z.object({
  id: ClassIdSchema, name: z.string(), aliases: z.array(z.string()),
  baseStats: z.object({ maxHP: z.number(), atk: z.number(), def: z.number(), initiative: z.number() }),
  slots: z.array(EquipmentSlotSchema).length(4), abilities: z.array(AbilityDefinitionSchema).length(4),
});

export const CharacterStateSchema = z.object({
  classId: ClassIdSchema, hpCurrent: z.number().nonnegative(), maxHP: z.number().positive(),
  atk: z.number(), def: z.number(), initiative: z.number(),
  statusEffects: z.array(ClassStatusEffectSchema), cooldowns: z.record(z.number().int().nonnegative()),
  disabledReasons: z.record(z.string()),
});
