import { z } from "zod";

/** The four playable classes defined by GDD 5.6. */
export const PlayerClassSchema = z.enum([
  "GARDIST",
  "CLERIC",
  "BILDHAUER",
  "CONDOTTIERE",
]);
export type PlayerClass = z.infer<typeof PlayerClassSchema>;

/** Authoritative, fully derived values returned by the server. */
export const CharacterStatsSchema = z.object({
  hpMax: z.number().int().nonnegative(),
  atk: z.number().nonnegative(),
  def: z.number().nonnegative(),
  initiative: z.number().nonnegative(),
});
export type CharacterStats = z.infer<typeof CharacterStatsSchema>;
