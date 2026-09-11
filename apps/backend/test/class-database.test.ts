import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("current schema exposes the partial uniqueness invariant for confirmed choices", async () => {
  const schema = await read("src/db/schema/player.ts");
  assert.match(schema, /uniqueIndex\("player_team_confirmed_class_unique"\)/);
  assert.match(schema, /\.on\(table\.teamId, table\.class\)/);
  assert.match(schema, /where\(sql`\$\{table\.classConfirmed\} = true AND \$\{table\.class\} IS NOT NULL`\)/);
});

test("current architecture persists GM overrides in shared auditEvents", async () => {
  const auditSchema = await read("src/db/schema/media.ts");
  const service = await read("src/modules/player/class-selection.service.ts");
  assert.match(auditSchema, /export const auditEvents = pgTable\("audit_event"/);
  assert.match(service, /insert\(auditEvents\)/);
  assert.match(service, /action: "CLASS_ASSIGNMENT_OVERRIDE"/);
});

test("transactional service locks teams, handles index conflicts, and grants starter weapons", async () => {
  const service = await read("src/modules/player/class-selection.service.ts");
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /code\?: string \}\)\.code === "23505"/);
  assert.match(service, /grantStarterWeapon\(player\.id, STARTER_WEAPONS\[playerClass\]\.id\)/);
});

test("active class migration creates the partial index rather than the legacy unconditional index", async () => {
  const migration = await read("src/db/migrations/0014_class_assignment.sql");
  assert.match(migration, /player_team_confirmed_class_unique[\s\S]*WHERE "class_confirmed" = true AND "class" IS NOT NULL/);
  assert.doesNotMatch(migration, /player_class_audit/);
});
