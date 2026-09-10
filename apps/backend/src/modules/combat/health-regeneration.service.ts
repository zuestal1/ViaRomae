import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";

export const REGEN_FULL_HEAL_SECONDS = 900;

/** Materializes elapsed regeneration whenever a player's state is read. */
export async function materializeHealthRegeneration(playerId: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const selected = await tx.execute(sql`
      SELECT p.id, p.team_id, p.hp_current, p.max_hp, p.status,
             p.last_regen_calculation_at, p.last_lat, p.last_lng,
             EXISTS (
               SELECT 1 FROM combatant c JOIN combat_instance ci ON ci.id = c.combat_instance_id
               WHERE c.entity_type = 'PLAYER' AND c.entity_id = p.id AND ci.state <> 'COMPLETED'
             ) AS active_combat,
             CASE WHEN p.last_lat IS NULL OR p.last_lng IS NULL THEN false ELSE EXISTS (
               SELECT 1 FROM play_area a WHERE ST_Covers(
                 a.geom, ST_SetSRID(ST_MakePoint(p.last_lng, p.last_lat), 4326)
               )
             ) END AS inside
      FROM player p WHERE p.id = ${playerId}::uuid FOR UPDATE
    `);
    const player = selected.rows[0] as undefined | {
      hp_current: number; max_hp: number; status: string; active_combat: boolean;
      inside: boolean; last_regen_calculation_at: Date | string;
    };
    if (!player) return;

    // Stopped periods must never be credited later.
    if (player.status === "DOWNED" || player.active_combat || !player.inside) {
      await tx.execute(sql`UPDATE player SET last_regen_calculation_at = ${now} WHERE id = ${playerId}::uuid`);
      return;
    }
    if (player.hp_current >= player.max_hp) {
      await tx.execute(sql`UPDATE player SET hp_current = max_hp, last_regen_calculation_at = ${now} WHERE id = ${playerId}::uuid`);
      return;
    }

    const elapsedMs = Math.max(0, now.getTime() - new Date(player.last_regen_calculation_at).getTime());
    const healed = Math.floor((elapsedMs * player.max_hp) / (REGEN_FULL_HEAL_SECONDS * 1_000));
    if (healed <= 0) return; // Retain fractional elapsed time for the next access.
    const nextHp = Math.min(player.max_hp, player.hp_current + healed);
    const consumedMs = nextHp === player.max_hp
      ? elapsedMs
      : (healed * REGEN_FULL_HEAL_SECONDS * 1_000) / player.max_hp;
    const nextCalculation = new Date(new Date(player.last_regen_calculation_at).getTime() + consumedMs);
    await tx.execute(sql`
      UPDATE player SET hp_current = ${nextHp}, last_regen_calculation_at = ${nextCalculation}
      WHERE id = ${playerId}::uuid
    `);
  });
}

export async function markTeamRegenStopped(teamId: string, now = new Date()): Promise<void> {
  await db.execute(sql`UPDATE player SET last_regen_calculation_at = ${now} WHERE team_id = ${teamId}::uuid`);
}
