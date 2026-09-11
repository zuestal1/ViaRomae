import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { decideQuestAcceptance, type RepeatabilityRun } from "../src/modules/quest/quest-repeatability.js";

const now = new Date("2026-09-11T12:00:00.000Z");
const run = (state: RepeatabilityRun["state"], completedAt: Date | null = null): RepeatabilityRun => ({
  state, startedAt: new Date("2026-09-11T10:00:00.000Z"), completedAt,
});

test("ACTIVE and PENDING_REVIEW always block another acceptance", () => {
  assert.deepEqual(decideQuestAcceptance([run("ACTIVE")], { repeatable: true, repeatCooldownSeconds: 0 }, now), { allowed: false, reason: "ACTIVE" });
  assert.deepEqual(decideQuestAcceptance([run("PENDING_REVIEW")], { repeatable: true, repeatCooldownSeconds: 0 }, now), { allowed: false, reason: "PENDING_REVIEW" });
});

test("a non-repeatable COMPLETED quest stays unavailable", () => {
  assert.deepEqual(decideQuestAcceptance([run("FAILED"), run("COMPLETED", new Date("2026-09-10T12:00:00Z"))], { repeatable: false, repeatCooldownSeconds: null }, now), { allowed: false, reason: "NOT_REPEATABLE" });
});

test("FAILED runs can be retried even when the quest is not repeatable", () => {
  assert.deepEqual(decideQuestAcceptance([run("FAILED")], { repeatable: false, repeatCooldownSeconds: null }, now), { allowed: true });
});

test("repeatable COMPLETED quests observe their cooldown and all prior runs", () => {
  const runs = [run("COMPLETED", new Date("2026-09-11T10:00:00Z")), run("FAILED"), run("COMPLETED", new Date("2026-09-11T11:30:00Z"))];
  assert.deepEqual(decideQuestAcceptance(runs, { repeatable: true, repeatCooldownSeconds: 3_600 }, now), {
    allowed: false, reason: "COOLDOWN", retryAt: new Date("2026-09-11T12:30:00Z"),
  });
  assert.deepEqual(decideQuestAcceptance(runs, { repeatable: true, repeatCooldownSeconds: 1_800 }, now), { allowed: true });
});

test("migration enforces one open run per team and quest definition", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0016_quest_repeatability.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE UNIQUE INDEX "quest_run_team_definition_open_unique"/);
  assert.match(migration, /WHERE "state" IN \('ACTIVE', 'PENDING_REVIEW'\)/);
});
