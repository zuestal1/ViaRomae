import { z } from "zod";

export const PlayerClassSchema = z.enum([
  "GARDIST",
  "MÖNCH",
  "HÄNDLER",
  "SPÄHER",
  "MAGIER",
]);
export type PlayerClass = z.infer<typeof PlayerClassSchema>;

export const PlayerStatusSchema = z.enum(["ACTIVE", "DOWNED"]);
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;
export const FameTierSchema = z.enum(["N", "R", "SR", "SSR", "E", "L"]);
export type FameTier = z.infer<typeof FameTierSchema>;

export const LocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  accuracy: z.number().optional(),
});
export type Location = z.infer<typeof LocationSchema>;

export const PlayerSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  teamId: z.string().uuid(),
  class: PlayerClassSchema,
  hpCurrent: z.number().int().nonnegative(),
  maxHp: z.number().int().positive(),
  fameTierHpBonus: z.number().int().nonnegative(),
  highestFameTierReached: FameTierSchema,
  lastRegenCalculationAt: z.string().datetime(),
  status: PlayerStatusSchema,
  lastLocation: LocationSchema.nullable(),
});
export type Player = z.infer<typeof PlayerSchema>;

export const TeamSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  fame: z.number().int(),
  denarii: z.number().int(),
  inventoryCapacity: z.number().int().default(40),
  highestFameTierReached: FameTierSchema,
});
export type Team = z.infer<typeof TeamSchema>;
