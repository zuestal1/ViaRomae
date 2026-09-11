import assert from "node:assert/strict";
import test from "node:test";
import { questBelongsToDay } from "../src/modules/gm/event-runtime.service.js";

test("quest day gating keeps long-term quests across both days", () => {
  assert.equal(questBelongsToDay("DAY_1", 1, "REGULAR"), true);
  assert.equal(questBelongsToDay("DAY_1", 2, "REGULAR"), false);
  assert.equal(questBelongsToDay("DAY_2", 1, "REGULAR"), false);
  assert.equal(questBelongsToDay("DAY_2", 2, "REGULAR"), true);
  assert.equal(questBelongsToDay("DAY_1_TO_DAY_2", 2, "LONG_TERM"), true);
});
