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
