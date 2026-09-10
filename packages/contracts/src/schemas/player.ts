import { z } from "zod";
import { CharacterStatsSchema, PlayerClassSchema } from "./character-class.js";

export { PlayerClassSchema } from "./character-class.js";
export type { PlayerClass } from "./character-class.js";

export const PlayerStatusSchema = z.enum(["ACTIVE", "DOWNED"]);
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;

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
  ...CharacterStatsSchema.shape,
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
});
export type Team = z.infer<typeof TeamSchema>;
