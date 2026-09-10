import { createHash, randomUUID } from "node:crypto";
import { assignLoot } from "./inventory.service.js";
import { appendLedgerEntry } from "./ledger.service.js";
import { awardFameAndApplyTiers } from "./fame-tiers.service.js";

export type RewardItem = { defKey: string; quantity: number };

export type RewardProfile = {
  fame: number;
  denarii: number;
  playerItems: RewardItem[];
  teamItems: RewardItem[];
};

export const QUEST_REWARD_PROFILE: RewardProfile = {
  fame: 100,
  denarii: 50,
  playerItems: [{ defKey: "gladius", quantity: 1 }],
  teamItems: [{ defKey: "potion_small", quantity: 1 }],
};

export const COMBAT_REWARD_PROFILE: RewardProfile = {
  fame: 25,
  denarii: 30,
  playerItems: [],
  teamItems: [{ defKey: "potion_small", quantity: 2 }],
};

export function profileFromEncounterLabel(label: string | null | undefined): RewardProfile {
  if (label === "COMBAT_REWARD_PROFILE") return COMBAT_REWARD_PROFILE;
  return QUEST_REWARD_PROFILE;
}

/** Deterministic UUID v4-shaped key from a seed string (idempotent rewards). */
export function uuidFromSeed(seed: string): string {
  const hash = createHash("sha256").update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type GrantedRewards = {
  glory: number;
  denarii: number;
  items: { defKey: string; quantity: number; owner: "PLAYER" | "TEAM" }[];
  itemsSkipped: boolean;
};

export async function grantRewards(opts: {
  seed: string;
  teamId: string;
  playerId: string;
  profile: RewardProfile;
  source: "QUEST" | "COMBAT";
}): Promise<GrantedRewards> {
  const { seed, teamId, playerId, profile, source } = opts;
  const items: GrantedRewards["items"] = [];
  let itemsSkipped = false;

  if (profile.fame !== 0) {
    await awardFameAndApplyTiers({ seed, teamId, playerId, amount: profile.fame, source });
  }

  if (profile.denarii !== 0) {
    await appendLedgerEntry({
      idempotencyKey: uuidFromSeed(`${seed}:denarii`),
      teamId,
      playerId,
      currencyType: "DENARII",
      amount: profile.denarii,
      source,
    });
  }

  async function tryLoot(
    ownerType: "PLAYER" | "TEAM",
    ownerId: string,
    lootItems: RewardItem[],
    keySuffix: string,
  ) {
    if (lootItems.length === 0) return;
    try {
      await assignLoot({
        idempotencyKey: uuidFromSeed(`${seed}:${keySuffix}`),
        ownerType,
        ownerId,
        items: lootItems,
        currencies: [],
      });
      for (const it of lootItems) {
        items.push({ defKey: it.defKey, quantity: it.quantity, owner: ownerType });
      }
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 409) {
        itemsSkipped = true;
        return;
      }
      throw err;
    }
  }

  await tryLoot("PLAYER", playerId, profile.playerItems, "player-items");
  await tryLoot("TEAM", teamId, profile.teamItems, "team-items");

  return {
    glory: profile.fame,
    denarii: profile.denarii,
    items,
    itemsSkipped,
  };
}

export function newIdempotencyKey(): string {
  return randomUUID();
}
