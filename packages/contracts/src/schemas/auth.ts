import { z } from "zod";
import { FameTierSchema, PlayerClassSchema, PlayerStatusSchema } from "./player.js";
import { CharacterStatsSchema, PlayerClassSchema } from "./character-class.js";
import { PlayerStatusSchema } from "./player.js";

export const RoleSchema = z.enum(["PLAYER", "GM", "ADMIN"]);
export type Role = z.infer<typeof RoleSchema>;

export const LoginRequestSchema = z.object({
  accessCode: z.string().min(4).max(64),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  token: z.string(),
  account: z.object({
    id: z.string().uuid(),
    username: z.string(),
    role: RoleSchema,
  }),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ── /me endpoint ─────────────────────────────────────────────────────────────

/** Full profile returned by GET /api/v1/auth/me */
export const MeResponseSchema = z.object({
  account: z.object({
    id: z.string().uuid(),
    username: z.string(),
    role: RoleSchema,
  }),
  /** Null for GM/ADMIN accounts that have no player record. */
  player: z
    .object({
      id: z.string().uuid(),
      class: PlayerClassSchema.nullable(),
      classConfirmed: z.boolean(),
      preflightCompleted: z.boolean(),
      hpCurrent: z.number().int().nonnegative(),
      maxHp: z.number().int().positive(),
      fameTierHpBonus: z.number().int().nonnegative(),
      highestFameTierReached: FameTierSchema,
      lastRegenCalculationAt: z.string().datetime(),
      ...CharacterStatsSchema.shape,
      status: PlayerStatusSchema,
      team: z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          inventoryCapacity: z.number().int(),
          fame: z.number().int(),
          denarii: z.number().int(),
          highestFameTierReached: FameTierSchema,
        })
        .nullable(),
    })
    .nullable(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
