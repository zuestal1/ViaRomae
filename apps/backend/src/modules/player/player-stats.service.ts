import type { CharacterStats, PlayerClass } from "@jlw/contracts";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { itemDefs, itemInstances } from "../../db/schema/economy_v2.js";
import { players } from "../../db/schema/player.js";
import { CLASSES } from "../classes/class-rules.js";

type StatName = "hp" | "atk" | "def" | "initiative";
type EquipmentStats = Partial<Record<StatName | `${StatName}Percent`, number>>;

// GDD 5.6/7.2 values live only on the authoritative server. The shared package
// describes the class identifiers and response shape, not a client-side table.
export interface StatModifiers {
  equipment?: EquipmentStats;
  fameTierHp?: number;
  permanent?: EquipmentStats;
  temporary?: EquipmentStats;
  percent?: EquipmentStats;
}

function derive(base: number, flat: number, percent: number): number {
  const cappedPercent = Math.max(-60, Math.min(100, percent));
  return Math.max(0, Math.floor((base + flat) * (1 + cappedPercent / 100) + 0.5));
}

/** Applies all flat modifiers first and percentage modifiers last. */
export function calculateCharacterStats(
  playerClass: PlayerClass,
  modifiers: StatModifiers = {},
): CharacterStats {
  const classBase = CLASSES[playerClass].baseStats;
  const base: CharacterStats = { hpMax: classBase.maxHP, atk: classBase.atk,
    def: classBase.def, initiative: classBase.initiative };
  const equipment = modifiers.equipment ?? {};
  const permanent = modifiers.permanent ?? {};
  const temporary = modifiers.temporary ?? {};
  const percent = modifiers.percent ?? {};
  const percentage = (stat: StatName) =>
    (equipment[`${stat}Percent`] ?? 0) +
    (permanent[`${stat}Percent`] ?? 0) +
    (temporary[`${stat}Percent`] ?? 0) +
    (percent[`${stat}Percent`] ?? 0);

  return {
    hpMax: derive(
      base.hpMax,
      (equipment.hp ?? 0) + (modifiers.fameTierHp ?? 0) +
        (permanent.hp ?? 0) + (temporary.hp ?? 0),
      percentage("hp"),
    ),
    atk: derive(base.atk, (equipment.atk ?? 0) + (permanent.atk ?? 0) +
      (temporary.atk ?? 0), percentage("atk")),
    def: derive(base.def, (equipment.def ?? 0) + (permanent.def ?? 0) +
      (temporary.def ?? 0), percentage("def")),
    initiative: derive(base.initiative,
      (equipment.initiative ?? 0) + (permanent.initiative ?? 0) +
        (temporary.initiative ?? 0), percentage("initiative")),
  };
}

function parseEquipmentStats(value: unknown): EquipmentStats {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, amount]) =>
      typeof amount === "number" && Number.isFinite(amount))) as EquipmentStats;
  } catch {
    return {};
  }
}

export async function getPlayerStats(player: typeof players.$inferSelect): Promise<CharacterStats> {
  if (!player.class) throw new Error("PLAYER_CLASS_NOT_CONFIRMED");
  const equipped = await db.select({ stats: itemDefs.stats }).from(itemInstances)
    .innerJoin(itemDefs, eq(itemDefs.key, itemInstances.definitionId))
    .where(and(eq(itemInstances.ownerId, player.id), eq(itemInstances.isEquipped, true)));
  const equipment = equipped.map(({ stats }) => parseEquipmentStats(stats)).reduce<EquipmentStats>(
    (total, stats) => {
      for (const [key, value] of Object.entries(stats)) {
        total[key as keyof EquipmentStats] = (total[key as keyof EquipmentStats] ?? 0) + value;
      }
      return total;
    }, {},
  );

  return calculateCharacterStats(player.class, {
    equipment,
    fameTierHp: player.fameTierHp,
    permanent: { hp: player.permanentHp, atk: player.permanentAttack,
      def: player.permanentDefense, initiative: player.permanentInitiative },
    temporary: { hp: player.temporaryHp, atk: player.temporaryAttack,
      def: player.temporaryDefense, initiative: player.temporaryInitiative },
    percent: { hpPercent: player.hpPercent, atkPercent: player.attackPercent,
      defPercent: player.defensePercent, initiativePercent: player.initiativePercent },
  });
}
