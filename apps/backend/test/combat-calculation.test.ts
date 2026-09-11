import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDamage,
  calculateDamage,
  calculateEffectiveInitiative,
  calculateEquipmentRarityScore,
  calculateHealing,
  calculateGeneratedThreat,
  compareRoundOrder,
  clampCombatPercent,
  commercialRound,
  selectThreatTarget,
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

test("Hellebardenstoss generates the dealt damage plus 50 percent threat", () => {
  assert.equal(calculateGeneratedThreat(41, 50), 62);
  assert.equal(calculateGeneratedThreat(41), 41);
});

test("enemy target switches to the living player with the highest threat", () => {
  assert.equal(selectThreatTarget([
    { id: "00000000-0000-0000-0000-000000000001", threat: 10 },
    { id: "00000000-0000-0000-0000-000000000002", threat: 20 },
  ])?.id, "00000000-0000-0000-0000-000000000002");
});

test("equal threat uses the documented ascending combatant UUID tie-breaker", () => {
  assert.equal(selectThreatTarget([
    { id: "00000000-0000-0000-0000-000000000002", threat: 20 },
    { id: "00000000-0000-0000-0000-000000000001", threat: 20 },
  ])?.id, "00000000-0000-0000-0000-000000000001");
});

test("removing the downed threat leader makes the next living player the target", () => {
  const candidates = [
    { id: "00000000-0000-0000-0000-000000000001", threat: 100, isDowned: true },
    { id: "00000000-0000-0000-0000-000000000002", threat: 25, isDowned: false },
    { id: "00000000-0000-0000-0000-000000000003", threat: 10, isDowned: false },
  ];
  assert.equal(selectThreatTarget(candidates.filter((candidate) => !candidate.isDowned))?.id,
    "00000000-0000-0000-0000-000000000002");
});

test("GDD percent caps and commercial rounding are enforced", () => {
  assert.equal(clampCombatPercent(-9), -0.6);
  assert.equal(clampCombatPercent(9), 1);
  assert.equal(commercialRound(2.49), 2);
  assert.equal(commercialRound(2.5), 3);
  assert.equal(calculateDamage(
    { attack: 100, defense: 0, initiative: 0, damageDealtPercent: 5 },
    { attack: 0, defense: 0, initiative: 0, damageTakenPercent: -5 },
  ), 80, "+100% dealt and -60% taken are the GDD caps");
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
