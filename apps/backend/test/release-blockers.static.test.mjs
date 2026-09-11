import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("every GM plugin installs the shared authorization hook", async () => {
  for (const file of ["src/modules/gm/gm-commands.routes.ts", "src/modules/gm/event-lifecycle.routes.ts", "src/modules/gm/seed-control.routes.ts", "src/modules/gm/gm-dashboard.routes.ts"]) {
    assert.match(await read(file), /addHook\("onRequest", fastify\.authorizeGM\)/, file);
  }
});

test("login JWT exposes one consistent actor identity", async () => {
  const source = await read("src/modules/auth/auth.routes.ts");
  assert.match(source, /sub: account\.id, accountId: account\.id/);
});

test("class availability uses permanent confirmations and legacy assignments are migrated", async () => {
  const source = await read("src/modules/player/class-selection.service.ts");
  const migration = await read("src/db/migrations/0020_confirm_seeded_classes.sql");
  assert.match(source, /eq\(players\.classConfirmed, true\)/);
  assert.match(migration, /WHERE class IS NOT NULL\s+AND class_confirmed = false/);
});

test("new players can load their profile before choosing a class", async () => {
  const source = await read("src/modules/auth/auth.service.ts");
  assert.doesNotMatch(source, /if \(!player\.class\) throw/);
  assert.match(source, /player\.class \? await getPlayerStats/);
});

test("media and boss routes resolve team membership from the authenticated account", async () => {
  for (const file of ["src/modules/media/media.routes.ts", "src/modules/combat/boss.routes.ts"]) {
    const source = await read(file);
    assert.doesNotMatch(source, /request\.user as \{ teamId: string \}/, file);
    assert.match(source, /players\.accountId/, file);
  }
});

test("quests enforce event state and day both when listing and accepting", async () => {
  const source = await read("src/modules/quest/quest.service.ts");
  assert.match(source, /runtime\.state !== "ACTIVE"/);
  assert.ok(source.match(/questBelongsToDay/g).length >= 2);
  assert.match(source, /requireActiveEvent\(tx\)/);
});

test("players have a non-GM leaderboard route with frozen standings", async () => {
  const index = await read("src/index.ts");
  const routes = await read("src/modules/gm/player-event.routes.ts");
  assert.match(index, /playerEventRoutes/);
  assert.match(routes, /getVisibleLeaderboard/);
  assert.doesNotMatch(routes, /authorizeGM/);
});

test("standard quest loot is granted to the team inventory", async () => {
  const source = await read("src/modules/quest/quest.service.ts");
  assert.match(source, /LOOT_ROLL:QUEST_STANDARD/);
  assert.match(source, /teamItems: standardLoot/);
});
