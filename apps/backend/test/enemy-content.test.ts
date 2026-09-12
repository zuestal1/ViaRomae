import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../../..");
const catalog = JSON.parse(readFileSync(join(root, "apps/backend/content/enemy-content-v0.10.json"), "utf8"));
const geojson = JSON.parse(readFileSync(join(root, "docs/Via_Romae_GameObjects_v0.8.geojson"), "utf8"));
const quests = JSON.parse(readFileSync(join(root, "apps/backend/content/quest-content-v0.10.json"), "utf8"));

test("all approved GDD combat profiles have balanced executable stats and behavior", () => {
  assert.equal(catalog.profiles.length, 35);
  for (const profile of catalog.profiles) {
    assert.ok(profile.stats.hp > 0 && profile.stats.atk > 0 && profile.stats.def >= 0);
    assert.ok(profile.stats.initiative > 0 && profile.stats.statusChance >= 0 && profile.stats.statusChance <= 1);
    assert.ok(profile.behavior.powerAttackEvery > 0 && profile.behavior.powerAttackMultiplier >= 1);
    assert.ok(profile.abilities.every((ability: unknown) => typeof ability === "string" && ability.length > 0));
  }
});

test("unique enemies occur exactly once and retain the canonical GDD balance", () => {
  const unique = geojson.features.filter((feature: any) => feature.properties.unique === true);
  assert.equal(unique.length, 12);
  assert.equal(new Set(unique.map((feature: any) => feature.properties.encounter_id)).size, 12);
  for (const feature of unique) {
    const profile = catalog.profiles.find((candidate: any) => candidate.id === feature.properties.combat_profile_id);
    assert.ok(profile);
    assert.deepEqual(
      [feature.properties.hp, feature.properties.atk, feature.properties.def, feature.properties.initiative],
      [profile.stats.hp, profile.stats.atk, profile.stats.def, profile.stats.initiative],
    );
  }
});

test("every fightable quest step targets its enemy at that step location", () => {
  const enemies = new Map(geojson.features
    .filter((feature: any) => feature.properties.system_type === "QUEST_ENEMY")
    .map((feature: any) => [feature.id, feature]));
  const steps = Object.values(quests.quests).flatMap((quest: any) => quest.steps)
    .filter((step: any) => step.actionType === "DEFEAT_ENEMY");
  assert.equal(steps.length, 18);
  assert.equal(enemies.size, 18);
  for (const step of steps) {
    const enemy: any = enemies.get(step.targetRef);
    assert.ok(enemy, `missing enemy for ${step.stepId}`);
    assert.equal(enemy.properties.quest_step_id, step.stepId);
    assert.equal(enemy.properties.candidate_id, step.locationId);
    assert.equal(enemy.properties.combat_profile_id, step.combatProfileId);
    assert.equal(enemy.properties.respawn_scope, "QUEST_INSTANCE_NO_RESPAWN");
  }
});
