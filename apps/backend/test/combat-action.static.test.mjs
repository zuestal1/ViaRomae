import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const service = await readFile(new URL("../src/modules/combat/combat.service.ts", import.meta.url), "utf8");
const schema = await readFile(new URL("../src/db/schema/combat.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../src/db/migrations/0013_combat_action_replacement.sql", import.meta.url), "utf8");

test("combat action identity is unique in schema and migration", () => {
  for (const source of [schema, migration]) {
    assert.match(source, /combat_action_instance_round_actor_unique/);
    assert.match(source, /combat_instance_id[\s\S]*round_number[\s\S]*actor_id/);
  }
});

test("submission replacement is conditional and lock creates automatic actions", () => {
  assert.match(service, /onConflictDoUpdate/);
  assert.match(service, /setWhere: eq\(combatActions\.isLocked, false\)/);
  assert.match(service, /origin: actor\.entityType === "PLAYER" \? "AUTOMATIC" : "ENEMY_AI"/);
  assert.match(service, /sort\(\(a, b\) => a\.id\.localeCompare\(b\.id\)\)/);
});
