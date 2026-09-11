import { z } from "zod";
import { StatusEffectSchema } from "./combat.js";
import { AbilityDefinitionSchema } from "./ability.js";
import { ItemSlotSchema } from "./economy.js";
import { FameTierSchema, PlayerStatusSchema } from "./player.js";
import { CharacterStatsSchema, PlayerClassSchema } from "./character-class.js";

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
      hpMax: z.number().int().positive().default(100),
      stats: z.object({ atk: z.number(), def: z.number(), init: z.number() }),
      icon: z.string(),
      passive: z.object({ name: z.string(), description: z.string(), icon: z.string() }),
      abilities: z.array(AbilityDefinitionSchema),
      statusEffects: z.array(StatusEffectSchema),
      equipment: z.array(z.object({
        slot: ItemSlotSchema,
        name: z.string().nullable(),
        icon: z.string().optional(),
      })),
      status: PlayerStatusSchema,
      team: z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          inventoryCapacity: z.number().int(),
          fame: z.number().int(),
          denarii: z.number().int(),
          members: z.array(z.object({
            id: z.string().uuid(),
            name: z.string(),
            class: PlayerClassSchema.nullable(),
            classConfirmed: z.boolean(),
            preflightCompleted: z.boolean(),
            hpCurrent: z.number().int().nonnegative(),
            hpMax: z.number().int().positive(),
          })),
          highestFameTierReached: FameTierSchema,
        })
        .nullable(),
    })
    .nullable(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
