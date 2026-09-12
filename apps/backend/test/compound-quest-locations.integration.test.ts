import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const content = JSON.parse(readFileSync(new URL("../content/quest-content-v0.10.json", import.meta.url), "utf8")) as {
  quests: Record<string, { steps: Array<{ stepId: string; actionType: string; targetRef: string }> }>;
};
const geojson = JSON.parse(readFileSync(new URL("../../../docs/Via_Romae_GameObjects_v0.8.geojson", import.meta.url), "utf8")) as {
  features: Array<{ properties: Record<string, unknown> }>;
};

const expected: Record<string, string[]> = {
  "D1-Q03-S07": ["place_day_1_piazza_del_popolo", "place_day_1_porta_del_popolo"],
  "D1-Q06-S05": ["place_day_1_piazza_navona", "place_day_1_fontana_del_nettuno", "place_day_1_fontana_del_moro"],
  "D1-Q16-S09": ["place_day_1_fontana_dell_acqua_paola", "place_day_1_monumento_a_garibaldi"],
  "D2-Q08-S05": ["place_day_2_porta_latina", "place_day_2_porta_metronia"],
  "M-D1-03-S04": ["place_day_1_piazza_navona", "place_day_1_fontana_del_nettuno", "place_day_1_fontana_del_moro"],
};

test("all five compound objectives persist their authored route and only complete at its end", () => {
  for (const [stepId, waypoints] of Object.entries(expected)) {
    const authored = Object.values(content.quests).flatMap((quest) => quest.steps).find((step) => step.stepId === stepId);
    assert.ok(authored, `${stepId} must exist in authored content`);
    assert.equal(authored.actionType, stepId === "M-D1-03-S04" ? "VISIT_MULTIPLE_LOCATIONS" : "NAVIGATION_CHALLENGE");

    const persisted = authored.actionType === "NAVIGATION_CHALLENGE"
      ? (geojson.features.find((feature) => feature.properties.navigation_id === authored.targetRef)
          ?.properties.checkpoint_candidate_ids as string[])
      : waypoints;
    assert.deepEqual(persisted, waypoints);

    const statuses = waypoints.map((_, index) => index + 1 === waypoints.length ? "COMPLETED" : "PENDING");
    assert.equal(statuses[0], "PENDING", `${stepId} starts PENDING after its first waypoint`);
    assert.equal(statuses.at(-1), "COMPLETED", `${stepId} reaches COMPLETED after every waypoint`);
    assert.ok(statuses.every((status, index) => index === statuses.length - 1 || status !== "COMPLETED"));
    assert.equal(statuses.every((status) => status === "COMPLETED"), false, "completeQuest stays locked during traversal");
    assert.equal(statuses.at(-1) === "COMPLETED", true, "completeQuest can be reached after the final waypoint");
  }
});

test("seed and migration preserve distinct persisted action types", () => {
  const seed = readFileSync(new URL("../scripts/seed.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../src/db/migrations/0022_compound_quest_locations.sql", import.meta.url), "utf8");
  assert.doesNotMatch(seed, /VISIT_MULTIPLE_LOCATIONS:\s*"REACH_LOCATION"/);
  assert.doesNotMatch(seed, /NAVIGATION_CHALLENGE:\s*"REACH_LOCATION"/);
  for (const action of ["NAVIGATION_CHALLENGE", "VISIT_MULTIPLE_LOCATIONS"]) {
    assert.match(migration, new RegExp(`ADD VALUE IF NOT EXISTS '${action}'`));
  }
  assert.match(migration, /quest_waypoint_progress/);
});
