import type { CharacterStats, PlayerClass } from "@jlw/contracts";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { itemDefs, itemInstances } from "../../db/schema/economy_v2.js";
import { players } from "../../db/schema/player.js";

type StatName = "hp" | "atk" | "def" | "initiative";
type EquipmentStats = Partial<Record<StatName | `${StatName}Percent`, number>>;

// GDD 5.6/7.2 values live only on the authoritative server. The shared package
// describes the class identifiers and response shape, not a client-side table.
const CLASS_BASE_STATS: Record<PlayerClass, CharacterStats> = {
  GARDIST: { hpMax: 120, atk: 8, def: 14, initiative: 8 },
  CLERIC: { hpMax: 90, atk: 7, def: 9, initiative: 10 },
  BILDHAUER: { hpMax: 100, atk: 11, def: 10, initiative: 8 },
  CONDOTTIERE: { hpMax: 100, atk: 14, def: 8, initiative: 12 },
};

export interface StatModifiers {
  equipment?: EquipmentStats;
  fameTierHp?: number;
  permanent?: EquipmentStats;
  temporary?: EquipmentStats;
  percent?: EquipmentStats;
}

function derive(base: number, flat: number, percent: number): number {
  return Math.max(0, Math.round((base + flat) * (1 + percent / 100)));
}

/** Applies all flat modifiers first and percentage modifiers last. */
export function calculateCharacterStats(
  playerClass: PlayerClass,
  modifiers: StatModifiers = {},
): CharacterStats {
  const base = CLASS_BASE_STATS[playerClass];
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
