/**
 * Epic 5 smoke tests against a live Postgres (DATABASE_URL).
 * Run: pnpm --filter @jlw/backend exec tsx scripts/test-epic5.ts
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import {
  assignLoot,
  listInventory,
  equipItem,
  unequipItem,
  computeEquippedStats,
} from "../src/modules/economy/inventory.service.js";
import { appendLedgerEntry, getTeamBalance } from "../src/modules/economy/ledger.service.js";
import { executeTeamTrade, createTradeOffer, acceptTradeOffer, rejectTradeOffer, listTradeOffers } from "../src/modules/economy/trade.service.js";
import { grantRewards, QUEST_REWARD_PROFILE, COMBAT_REWARD_PROFILE } from "../src/modules/economy/rewards.service.js";

let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  FAIL  ${msg}`);
  } else {
    console.log(`  OK    ${msg}`);
  }
}

async function main(): Promise<void> {
  const suffix = Date.now().toString(36);

  const t1 = await db.execute(sql`
    INSERT INTO team (id, name) VALUES (gen_random_uuid(), ${`T1-${suffix}`}) RETURNING id
  `);
  const t2 = await db.execute(sql`
    INSERT INTO team (id, name) VALUES (gen_random_uuid(), ${`T2-${suffix}`}) RETURNING id
  `);
  const team1Id = (t1.rows as { id: string }[])[0]!.id;
  const team2Id = (t2.rows as { id: string }[])[0]!.id;

  const acc = await db.execute(sql`
    INSERT INTO account (id, username, access_code_hash, role)
    VALUES (gen_random_uuid(), ${`u-${suffix}`}, 'testhash', 'PLAYER')
    RETURNING id
  `);
  const accountId = (acc.rows as { id: string }[])[0]!.id;

  const pl = await db.execute(sql`
    INSERT INTO player (id, account_id, team_id, class, hp_current, status)
    VALUES (gen_random_uuid(), ${accountId}::uuid, ${team1Id}::uuid, 'guard', 120, 'ACTIVE')
    RETURNING id
  `);
  const playerId = (pl.rows as { id: string }[])[0]!.id;

  await db.execute(sql`
    INSERT INTO item_def (id, key, name, equip_slot, stats, stackable, max_stack)
    VALUES
      (gen_random_uuid(), ${`sword_${suffix}`}, 'Basic Sword', 'WEAPON', '{"atk":5}'::jsonb, false, 1),
      (gen_random_uuid(), ${`potion_${suffix}`}, 'Potion', 'CONSUMABLE', '{}'::jsonb, true, 99)
    ON CONFLICT (key) DO NOTHING
  `);

  console.log("\n-- Ledger idempotency");
  const ledKey = randomUUID();
  const first = await appendLedgerEntry({
    idempotencyKey: ledKey,
    teamId: team1Id,
    playerId,
    currencyType: "DENARII",
    amount: 250,
    source: "QUEST",
  });
  const second = await appendLedgerEntry({
    idempotencyKey: ledKey,
    teamId: team1Id,
    playerId,
    currencyType: "DENARII",
    amount: 250,
    source: "QUEST",
  });
  assert(first && (first as { id: string }).id, "ledger insert returns a row");
  assert(
    (first as { id: string }).id === (second as { id: string }).id,
    "duplicate ledger key returns same row",
  );
  assert((await getTeamBalance(team1Id, "DENARII")) === 250, "team DENARII balance is 250");

  console.log("\n-- Player loot + idempotency");
  const lootKey = randomUUID();
  const loot1 = await assignLoot({
    idempotencyKey: lootKey,
    ownerType: "PLAYER",
    ownerId: playerId,
    items: [{ defKey: `sword_${suffix}`, quantity: 1 }],
    currencies: [{ currencyType: "FAME", amount: 10, playerId }],
  });
  const loot2 = await assignLoot({
    idempotencyKey: lootKey,
    ownerType: "PLAYER",
    ownerId: playerId,
    items: [{ defKey: `sword_${suffix}`, quantity: 1 }],
  });
  assert(loot1.alreadyProcessed === false, "first loot is processed");
  assert(loot2.alreadyProcessed === true, "second loot with same key is skipped");
  const inv = (await listInventory("PLAYER", playerId)) as { id: string }[];
  assert(inv.length === 1, "player has exactly 1 sword instance");

  console.log("\n-- Inventory limit");
  try {
    await assignLoot({
      idempotencyKey: randomUUID(),
      ownerType: "PLAYER",
      ownerId: playerId,
      items: [{ defKey: `potion_${suffix}`, quantity: 20 }],
    });
    assert(false, "loot over personal limit should throw");
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    assert(e.statusCode === 409, "over-limit loot returns 409");
  }

  console.log("\n-- Equip / stats / unequip");
  const swordId = inv[0]!.id;
  const eq = await equipItem(accountId, swordId);
  assert(eq.slot === "WEAPON", "sword equips into WEAPON");
  const statsOn = await computeEquippedStats("PLAYER", playerId);
  assert(statsOn["atk"] === 5, "equipped ATK is 5");
  await unequipItem(accountId, swordId);
  const statsOff = await computeEquippedStats("PLAYER", playerId);
  assert(Object.keys(statsOff).length === 0, "unequipped stats are empty");

  console.log("\n-- Team loot + trade");
  await assignLoot({
    idempotencyKey: randomUUID(),
    ownerType: "TEAM",
    ownerId: team1Id,
    items: [{ defKey: `potion_${suffix}`, quantity: 3 }],
    currencies: [{ currencyType: "DENARII", amount: 50 }],
  });
  const teamInv = (await listInventory("TEAM", team1Id)) as {
    id: string;
    quantity: number;
  }[];
  assert(teamInv.length === 1 && Number(teamInv[0]!.quantity) === 3, "team has 3 potions");

  const tradeKey = randomUUID();
  const trade1 = await executeTeamTrade({
    idempotencyKey: tradeKey,
    senderTeamId: team1Id,
    receiverTeamId: team2Id,
    items: [{ itemInstanceId: teamInv[0]!.id, quantity: 3 }],
    currencies: [{ currencyType: "DENARII", amount: 100 }],
  });
  const trade2 = await executeTeamTrade({
    idempotencyKey: tradeKey,
    senderTeamId: team1Id,
    receiverTeamId: team2Id,
    items: [{ itemInstanceId: teamInv[0]!.id, quantity: 3 }],
    currencies: [{ currencyType: "DENARII", amount: 100 }],
  });
  assert(trade1.alreadyProcessed === false, "first trade is processed");
  assert(trade2.alreadyProcessed === true, "second trade with same key is skipped");

  const t1Items = await listInventory("TEAM", team1Id);
  const t2Items = (await listInventory("TEAM", team2Id)) as { quantity: number }[];
  assert(t1Items.length === 0, "sender team has no potions after trade");
  assert(t2Items.length === 1 && Number(t2Items[0]!.quantity) === 3, "receiver team has 3 potions");
  assert((await getTeamBalance(team1Id, "DENARII")) === 200, "sender DENARII is 200 after -100");
  assert((await getTeamBalance(team2Id, "DENARII")) === 100, "receiver DENARII is 100");

  console.log("\n-- Two-sided offer / accept");
  await assignLoot({
    idempotencyKey: randomUUID(),
    ownerType: "TEAM",
    ownerId: team1Id,
    items: [{ defKey: `potion_${suffix}`, quantity: 2 }],
  });
  const t1Again = (await listInventory("TEAM", team1Id)) as { id: string; quantity: number }[];
  const offer = await createTradeOffer({
    initiatorTeamId: team1Id,
    counterpartyTeamId: team2Id,
    side: { items: [{ itemInstanceId: t1Again[0]!.id, quantity: 1 }], denarii: 0 },
  });
  const listed = await listTradeOffers(team2Id);
  assert(listed.incoming.length === 1, "counterparty sees incoming offer");
  try {
    await acceptTradeOffer({
      offerId: offer.id,
      teamId: team2Id,
      counterSide: { items: [], denarii: 0 },
    });
    assert(false, "empty counter-offer should fail");
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    assert(e.statusCode === 400, "empty counter-offer returns 400");
  }
  await acceptTradeOffer({
    offerId: offer.id,
    teamId: team2Id,
    counterSide: { items: [], denarii: 20 },
  });
  assert((await getTeamBalance(team1Id, "DENARII")) === 220, "initiator gained 20 denarii");
  assert((await getTeamBalance(team2Id, "DENARII")) === 80, "counterparty spent 20 denarii");

  const rejectOffer = await createTradeOffer({
    initiatorTeamId: team1Id,
    counterpartyTeamId: team2Id,
    side: { items: [], denarii: 10 },
  });
  await rejectTradeOffer({ offerId: rejectOffer.id, teamId: team2Id });
  const afterReject = await listTradeOffers(team1Id);
  assert(
    afterReject.outgoing.every((o) => o.id !== rejectOffer.id),
    "rejected offer no longer listed as open",
  );

  console.log("\n-- Team inventory limit 40");
  try {
    await assignLoot({
      idempotencyKey: randomUUID(),
      ownerType: "TEAM",
      ownerId: team2Id,
      items: [{ defKey: `potion_${suffix}`, quantity: 40 }],
    });
    assert(false, "team loot over 40 should throw");
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    assert(e.statusCode === 409, "over-limit team loot returns 409");
  }

  console.log("\n-- Reward profiles (catalog items)");
  await db.execute(sql`
    INSERT INTO item_def (id, key, name, equip_slot, stats, stackable, max_stack)
    VALUES
      (gen_random_uuid(), 'gladius', 'Gladius', 'WEAPON', '{"atk":5}'::jsonb, false, 1),
      (gen_random_uuid(), 'potion_small', 'Heiltrank', 'CONSUMABLE', '{"heal":20}'::jsonb, true, 99)
    ON CONFLICT (key) DO NOTHING
  `);
  const acc2 = await db.execute(sql`
    INSERT INTO account (id, username, access_code_hash, role)
    VALUES (gen_random_uuid(), ${`u2-${suffix}`}, 'testhash', 'PLAYER')
    RETURNING id
  `);
  const account2Id = (acc2.rows as { id: string }[])[0]!.id;
  const pl2 = await db.execute(sql`
    INSERT INTO player (id, account_id, team_id, class, hp_current, status)
    VALUES (gen_random_uuid(), ${account2Id}::uuid, ${team2Id}::uuid, 'guard', 120, 'ACTIVE')
    RETURNING id
  `);
  const player2Id = (pl2.rows as { id: string }[])[0]!.id;

  const questGrant = await grantRewards({
    seed: `test-quest:${suffix}`,
    teamId: team2Id,
    playerId: player2Id,
    profile: QUEST_REWARD_PROFILE,
    source: "QUEST",
  });
  assert(questGrant.glory === 100 && questGrant.denarii === 50, "quest profile currency");
  const combatGrant = await grantRewards({
    seed: `test-combat:${suffix}`,
    teamId: team2Id,
    playerId: player2Id,
    profile: COMBAT_REWARD_PROFILE,
    source: "COMBAT",
  });
  assert(combatGrant.glory === 25 && combatGrant.denarii === 30, "combat profile currency");
  const again = await grantRewards({
    seed: `test-quest:${suffix}`,
    teamId: team2Id,
    playerId: player2Id,
    profile: QUEST_REWARD_PROFILE,
    source: "QUEST",
  });
  assert(again.glory === 100, "repeat grantRewards is idempotent for ledger");
  assert(
    (await getTeamBalance(team2Id, "FAME")) === 125,
    "fame not doubled on repeat grant (100 quest + 25 combat)",
  );

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Epic 5 smoke tests passed.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
