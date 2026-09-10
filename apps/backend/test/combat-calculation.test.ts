import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDamage,
  calculateDamage,
  calculateEffectiveInitiative,
  calculateEquipmentRarityScore,
  calculateHealing,
  compareRoundOrder,
} from "../src/modules/combat/combat-calculation.js";

test("damage follows GDD 7.10 and rounds only at the end", () => {
  const damage = calculateDamage(
    { attack: 100, defense: 0, initiative: 0, damageDealtPercent: 0.2 },
    { attack: 0, defense: 50, initiative: 0, defensePercent: 0.2, defenseFlat: 10, damageTakenPercent: 0.1 },
    1.5,
  );
  // 150 * 1.2 * (1 - 70/120) * 1.1 = 82.5
  assert.equal(damage, 83);
  assert.equal(calculateDamage(
    { attack: 0, defense: 0, initiative: 0 },
    { attack: 0, defense: 999, initiative: 0 },
  ), 1);
});

test("shield is consumed before HP", () => {
  assert.deepEqual(applyDamage(20, 7, 10), {
    damage: 10, absorbedByShield: 7, hpDamage: 3, hpAfter: 17, shieldAfter: 0,
  });
});

test("healing is rounded after modifiers and cannot overheal", () => {
  assert.equal(calculateHealing(5, 0.5, 90, 100), 8);
  assert.equal(calculateHealing(5, 0.5, 98, 100), 2);
  assert.equal(calculateHealing(5, 0.5, 100, 100), 0);
});

test("round ordering uses initiative, four-slot rarity, then persisted random", () => {
  assert.equal(calculateEffectiveInitiative({ attack: 0, defense: 0, initiative: 50, initiativePercent: 0.2, initiativeFlat: 3 }), 63);
  assert.equal(calculateEquipmentRarityScore(["N", "R", "SSR", "L", "L"]), 9);
  const lowRarity = { actorId: "a", effectiveInitiative: 50, equipmentRarityScore: 1, roundRandom: 999 };
  const highRarity = { actorId: "b", effectiveInitiative: 50, equipmentRarityScore: 2, roundRandom: 1 };
  assert.ok(compareRoundOrder(lowRarity, highRarity) > 0);
  assert.ok(compareRoundOrder({ ...highRarity, actorId: "c", roundRandom: 0 }, highRarity) > 0);
});
