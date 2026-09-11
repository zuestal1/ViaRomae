export const INVENTORY_LIMITS = { PLAYER: 20, TEAM: 40 } as const;
export const DEFAULT_MAX_STACK = 10;

export type ItemStatKey = "maxHP" | "ATK" | "DEF" | "INIT" | "INIT_TIE_BREAKER" |
  "healingPercent" | "armorBreakPercentPoints";
export type ItemStats = Partial<Record<ItemStatKey, number>>;

export const RARITY_MULTIPLIERS = {
  N: 1, R: 1.25, SR: 1.55, SSR: 1.9, E: 2.3, L: 2.8,
} as const;

export function parseItemStats(raw: unknown): ItemStats {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, amount]) =>
      typeof amount === "number" && Number.isFinite(amount))) as ItemStats;
  } catch { return {}; }
}

/** GDD 9.3/9.10: rarity scales N base stats; HP rounds to the nearest five. */
export function effectiveItemStats(raw: unknown, rarity: string): ItemStats {
  const base = parseItemStats(raw);
  const multiplier = RARITY_MULTIPLIERS[rarity as keyof typeof RARITY_MULTIPLIERS] ?? 1;
  return Object.fromEntries(Object.entries(base).map(([key, amount]) => [key,
    key === "maxHP" ? Math.round((amount * multiplier) / 5) * 5 : Math.round(amount * multiplier),
  ])) as ItemStats;
}

export function normalizeTradeItems(items: Array<{ itemInstanceId: string; quantity: number }>) {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.itemInstanceId,
    (totals.get(item.itemInstanceId) ?? 0) + item.quantity);
  return [...totals].map(([itemInstanceId, quantity]) => ({ itemInstanceId, quantity }));
}
