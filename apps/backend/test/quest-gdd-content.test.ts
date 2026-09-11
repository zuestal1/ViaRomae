import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type Quest = {
  type: string;
  durationMin: number;
  durationMax: number;
  reward: { glory: number; denarii: number; itemRule: string };
  slotRule: string;
  steps: Array<{ stepId: string; sequence: number; category: string }>;
  dialogues: Array<{ text: string; options: unknown[] }>;
  timers: Array<{ durationSec: number; startsWhen: string; onExpire: string }>;
};

const content = JSON.parse(readFileSync(new URL("../content/quest-content-v0.10.json", import.meta.url), "utf8")) as {
  quests: Record<string, Quest>;
};

test("canonical Quest Master content is complete and internally ordered", () => {
  const quests = Object.values(content.quests);
  assert.equal(quests.length, 40);
  assert.equal(quests.reduce((sum, quest) => sum + quest.steps.length, 0), 396);
  assert.equal(quests.reduce((sum, quest) => sum + quest.dialogues.length, 0), 120);
  assert.equal(quests.reduce((sum, quest) => sum + quest.timers.length, 0), 6);
  for (const quest of quests) {
    assert.deepEqual(quest.steps.map((step) => step.sequence), [...quest.steps].map((step) => step.sequence).sort((a, b) => a - b));
    assert.equal(new Set(quest.steps.map((step) => step.stepId)).size, quest.steps.length);
    assert.ok(quest.dialogues.every((dialogue) => dialogue.text.length <= 1_000));
  }
});

test("GDD regular and hidden reward bands are exact", () => {
  for (const quest of Object.values(content.quests)) {
    if (quest.type === "HIDDEN") assert.deepEqual([quest.reward.glory, quest.reward.denarii], [30, 20]);
    if (quest.type !== "REGULAER") continue;
    const duration = `${quest.durationMin}-${quest.durationMax}`;
    const expected: Record<string, [number, number]> = { "5-15": [35, 20], "15-25": [55, 30], "25-35": [80, 45], "35-45": [110, 60] };
    assert.deepEqual([quest.reward.glory, quest.reward.denarii], expected[duration], `${duration} reward band`);
  }
});

test("chronicle and timer contracts carry mandatory GDD mechanics", () => {
  const chronicle = content.quests["M-LT-01"]!;
  assert.equal(chronicle.type, "MEDIA_LANGZEIT");
  assert.match(chronicle.slotRule, /CHRONICLE/i);
  assert.match(JSON.stringify(chronicle.steps), /6–12 Fotos/);
  for (const timer of Object.values(content.quests).flatMap((quest) => quest.timers)) {
    assert.ok(timer.durationSec > 0);
    assert.ok(timer.startsWhen.length > 20);
    assert.ok(timer.onExpire.length > 20);
  }
});

test("GM review client uses the registered media review route", () => {
  const routes = readFileSync(new URL("../src/modules/media/media.routes.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../../gm-client/src/components/MediaInbox.tsx", import.meta.url), "utf8");
  assert.match(routes, /"\/:id\/review"/);
  assert.match(client, /media\/\$\{submissionId\}\/review/);
  assert.doesNotMatch(client, /media\/submissions\/\$\{submissionId\}\/review/);
});
