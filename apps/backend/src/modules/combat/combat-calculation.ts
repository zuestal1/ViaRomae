/** Pure, server-authoritative combat arithmetic (GDD 7.10). */

export interface CombatStats {
  attack: number;
  defense: number;
  initiative: number;
  damageDealtPercent?: number;
  defensePercent?: number;
  defenseFlat?: number;
  damageTakenPercent?: number;
  initiativePercent?: number;
  initiativeFlat?: number;
  healingPercent?: number;
}

export interface DamageResult {
  damage: number;
  absorbedByShield: number;
  hpDamage: number;
  hpAfter: number;
  shieldAfter: number;
}

const finite = (value: number | undefined, fallback = 0) =>
  Number.isFinite(value) ? (value as number) : fallback;

/** GDD 7.10 uses commercial rounding for all final combat values. */
export const commercialRound = (value: number): number => Math.floor(finite(value) + 0.5);
export const clampCombatPercent = (value: number | undefined): number =>
  Math.max(-0.6, Math.min(1, finite(value)));

/** Implements the formula in its specified order; there is deliberately no RNG. */
export function calculateDamage(
  attacker: CombatStats,
  defender: CombatStats,
  abilityMultiplier = 1,
): number {
  const rawDamage = Math.max(0, finite(attacker.attack) * finite(abilityMultiplier));
  const dealtDamage = rawDamage * (1 + clampCombatPercent(attacker.damageDealtPercent));
  const effectiveDefense = Math.max(
    0,
    finite(defender.defense) * (1 + clampCombatPercent(defender.defensePercent)) +
      finite(defender.defenseFlat),
  );
  const reduction = effectiveDefense / (effectiveDefense + 50);
  const reducedDamage = dealtDamage * (1 - reduction);
  const modifiedDamage = reducedDamage * (1 + clampCombatPercent(defender.damageTakenPercent));
  return Math.max(1, commercialRound(modifiedDamage));
}

/** Shields absorb the rounded successful hit before HP is changed. */
export function applyDamage(hp: number, shield: number, damage: number): DamageResult {
  const safeHp = Math.max(0, finite(hp));
  const safeShield = Math.max(0, finite(shield));
  const successfulDamage = Math.max(1, commercialRound(damage));
  const absorbedByShield = Math.min(safeShield, successfulDamage);
  const hpDamage = Math.min(safeHp, successfulDamage - absorbedByShield);
  return {
    damage: successfulDamage,
    absorbedByShield,
    hpDamage,
    hpAfter: safeHp - hpDamage,
    shieldAfter: safeShield - absorbedByShield,
  };
}

export function calculateHealing(
  baseHealing: number,
  healingPercent: number,
  hpCurrent: number,
  hpMax: number,
): number {
  const missingHp = Math.max(0, finite(hpMax) - finite(hpCurrent));
  const modifiedHealing = Math.max(0, finite(baseHealing) * (1 + clampCombatPercent(healingPercent)));
  return Math.min(missingHp, commercialRound(modifiedHealing));
}

export function calculateEffectiveInitiative(stats: CombatStats): number {
  return finite(stats.initiative) * (1 + finite(stats.initiativePercent)) +
    finite(stats.initiativeFlat);
}

export type EquipmentRarity = "N" | "R" | "SR" | "SSR" | "E" | "L";
const RARITY_SCORE: Record<EquipmentRarity, number> = { N: 0, R: 1, SR: 2, SSR: 3, E: 4, L: 5 };

export function calculateEquipmentRarityScore(slots: ReadonlyArray<EquipmentRarity | undefined>): number {
  return slots.slice(0, 4).reduce<number>((score, rarity) => score + (rarity ? RARITY_SCORE[rarity] : 0), 0);
}

export interface RoundOrderEntry {
  actorId: string;
  effectiveInitiative: number;
  equipmentRarityScore: number;
  roundRandom: number;
}

export function compareRoundOrder(a: RoundOrderEntry, b: RoundOrderEntry): number {
  return b.effectiveInitiative - a.effectiveInitiative ||
    b.equipmentRarityScore - a.equipmentRarityScore ||
    b.roundRandom - a.roundRandom ||
    a.actorId.localeCompare(b.actorId);
}
