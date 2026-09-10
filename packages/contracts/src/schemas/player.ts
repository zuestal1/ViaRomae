import { z } from "zod";

export const PlayerClassSchema = z.enum([
  "GARDIST",
  "MÖNCH",
  "HÄNDLER",
  "SPÄHER",
  "MAGIER",
]);
export type PlayerClass = z.infer<typeof PlayerClassSchema>;

/** The four playable classes defined by the GDD (MAGIER is legacy data only). */
export const SelectablePlayerClassSchema = z.enum([
  "GARDIST",
  "MÖNCH",
  "HÄNDLER",
  "SPÄHER",
]);
export type SelectablePlayerClass = z.infer<typeof SelectablePlayerClassSchema>;

export const SelectClassRequestSchema = z.object({ class: SelectablePlayerClassSchema });
export const ConfirmClassRequestSchema = z.object({ class: SelectablePlayerClassSchema });
export const GMClassOverrideRequestSchema = z.object({
  playerId: z.string().uuid(),
  class: SelectablePlayerClassSchema,
  reason: z.string().trim().min(5).max(500),
});

export const ClassSelectionStateSchema = z.object({
  playerId: z.string().uuid(),
  teamId: z.string().uuid(),
  selectedClass: SelectablePlayerClassSchema.nullable(),
  confirmed: z.boolean(),
  confirmedAt: z.string().datetime().nullable(),
  preflightCompleted: z.boolean(),
  mapAccessGranted: z.boolean(),
  availability: z.array(z.object({
    class: SelectablePlayerClassSchema,
    available: z.boolean(),
    occupiedByPlayerId: z.string().uuid().nullable(),
  })),
});
export type ClassSelectionState = z.infer<typeof ClassSelectionStateSchema>;

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
  class: PlayerClassSchema.nullable(),
  hpCurrent: z.number().int().nonnegative(),
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
