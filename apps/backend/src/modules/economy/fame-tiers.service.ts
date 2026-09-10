import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../db/client.js";

export type FameTier = "N" | "R" | "SR" | "SSR" | "E" | "L";

/** GDD values. hpBonus is cumulative and rewards are awarded once per team. */
export const FAME_TIERS = [
  { tier: "N", fame: 0, denarii: 0, hpBonus: 0 },
  { tier: "R", fame: 500, denarii: 40, hpBonus: 1 },
  { tier: "SR", fame: 1_000, denarii: 60, hpBonus: 3 },
  { tier: "SSR", fame: 1_800, denarii: 80, hpBonus: 6 },
  { tier: "E", fame: 2_800, denarii: 110, hpBonus: 10 },
  { tier: "L", fame: 4_000, denarii: 150, hpBonus: 15 },
] as const;

const rank = (tier: FameTier) => FAME_TIERS.findIndex((entry) => entry.tier === tier);
const keyFromSeed = (seed: string): string => {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Posts fame and every newly crossed tier in one transaction. The team row lock
 * serializes concurrent awards; deterministic per-team/tier ledger keys make
 * the one-off denarii bookings retry-safe as an additional line of defence.
 */
export async function awardFameAndApplyTiers(opts: {
  seed: string;
  teamId: string;
  playerId: string;
  amount: number;
  source: "QUEST" | "COMBAT";
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM team WHERE id = ${opts.teamId}::uuid FOR UPDATE`);
    await tx.execute(sql`
      INSERT INTO ledger_entry
        (id, team_id, player_id, currency_type, amount, source, idempotency_key, created_at)
      VALUES (gen_random_uuid(), ${opts.teamId}::uuid, ${opts.playerId}::uuid,
        'FAME'::currency_type, ${opts.amount}, ${opts.source}::ledger_source,
        ${keyFromSeed(`${opts.seed}:fame`)}::uuid, now())
      ON CONFLICT (idempotency_key) DO NOTHING
    `);

    const result = await tx.execute(sql`
      SELECT t.highest_fame_tier_reached AS tier,
        COALESCE(SUM(l.amount) FILTER (WHERE l.currency_type = 'FAME'), 0) AS fame
      FROM team t LEFT JOIN ledger_entry l ON l.team_id = t.id
      WHERE t.id = ${opts.teamId}::uuid GROUP BY t.id
    `);
    const current = String((result.rows[0] as { tier: string }).tier) as FameTier;
    const fame = Number((result.rows[0] as { fame: string }).fame);
    const reached = [...FAME_TIERS].reverse().find((entry) => fame >= entry.fame)!;
    if (rank(reached.tier) <= rank(current)) return;

    for (const entry of FAME_TIERS) {
      if (entry.denarii === 0 || rank(entry.tier) <= rank(current) || rank(entry.tier) > rank(reached.tier)) continue;
      await tx.execute(sql`
        INSERT INTO ledger_entry
          (id, team_id, currency_type, amount, source, idempotency_key, created_at)
        VALUES (gen_random_uuid(), ${opts.teamId}::uuid, 'DENARII'::currency_type,
          ${entry.denarii}, 'ADMIN'::ledger_source,
          ${keyFromSeed(`fame-tier:${opts.teamId}:${entry.tier}`)}::uuid, now())
        ON CONFLICT (idempotency_key) DO NOTHING
      `);
    }
    await tx.execute(sql`UPDATE team SET highest_fame_tier_reached = ${reached.tier}::fame_tier WHERE id = ${opts.teamId}::uuid`);
    await tx.execute(sql`
      UPDATE player SET
        max_hp = max_hp + (${reached.hpBonus} - fame_tier_hp_bonus),
        hp_current = LEAST(hp_current + (${reached.hpBonus} - fame_tier_hp_bonus),
                           max_hp + (${reached.hpBonus} - fame_tier_hp_bonus)),
        fame_tier_hp_bonus = ${reached.hpBonus},
        highest_fame_tier_reached = ${reached.tier}::fame_tier
      WHERE team_id = ${opts.teamId}::uuid
        AND fame_tier_hp_bonus < ${reached.hpBonus}
    `);
  });
}
