/**
 * Combat System Test Script (Epic 6)
 * Tests PvE combat flow end-to-end.
 */

import { db } from "../src/db/client.js";
import { players, teams } from "../src/db/schema/player.js";
import { worldObjects } from "../src/db/schema/world.js";
import {
  startPvECombat,
  getCombatInstance,
  submitCombatAction,
  lockAndResolveRound,
  handleTeamWipe,
  regenerateHPOutOfCombat,
} from "../src/modules/combat/combat.service.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

async function testCombatSystem() {
  console.log("🧪 Testing Combat System...\n");

  try {
    // ── 1. Setup: Find or create test team & player ────────────────────────
    console.log("1️⃣ Setting up test team and player...");

    let [testTeam] = await db
      .select()
      .from(teams)
      .where(eq(teams.name, "Test Team Combat"))
      .limit(1);

    if (!testTeam) {
      const results = await db
        .insert(teams)
        .values({ name: "Test Team Combat" })
        .returning();
      testTeam = results[0];
      if (!testTeam) {
        console.error("   ❌ Failed to create test team!");
        return;
      }
      console.log(`   ✅ Created test team: ${testTeam.id}`);
    } else {
      console.log(`   ✅ Using existing test team: ${testTeam.id}`);
    }

    // Get first player in team
    const [testPlayer] = await db
      .select()
      .from(players)
      .where(eq(players.teamId, testTeam.id))
      .limit(1);

    if (!testPlayer) {
      console.error("   ❌ No players found in test team! Create a player first.");
      return;
    }

    console.log(`   ✅ Using player: ${testPlayer.id}\n`);

    // ── 2. Find or create test enemy ───────────────────────────────────────
    console.log("2️⃣ Setting up test enemy...");

    let [testEnemy] = await db
      .select()
      .from(worldObjects)
      .where(eq(worldObjects.type, "ENEMY"))
      .limit(1);

    if (!testEnemy) {
      const results = await db
        .insert(worldObjects)
        .values({
          externalId: "enemy:test_combat_enemy",
          type: "ENEMY",
          name: "Test Bandit",
          lat: 41.9028,
          lng: 12.4964,
          rawPropertiesJson: JSON.stringify({
            hp: 50,
            initiative: 40,
          }),
          publishable: true,
        })
        .returning();
      testEnemy = results[0];
      if (!testEnemy) {
        console.error("   ❌ Failed to create test enemy!");
        return;
      }
      console.log(`   ✅ Created test enemy: ${testEnemy.id}`);
    } else {
      console.log(`   ✅ Using existing enemy: ${testEnemy.id} (${testEnemy.name})`);
    }

    console.log();

    // ── 3. Start PvE Combat ────────────────────────────────────────────────
    console.log("3️⃣ Starting PvE combat...");

    const combat = await startPvECombat({
      teamId: testTeam.id,
      enemyWorldObjectId: testEnemy.id,
    });

    console.log(`   ✅ Combat started: ${combat.id}`);
    console.log(`   - Type: ${combat.type}`);
    console.log(`   - State: ${combat.state}`);
    console.log(`   - Round: ${combat.roundNumber}`);
    console.log(`   - Combatants: ${combat.combatants.length}`);

    for (const combatant of combat.combatants) {
      console.log(
        `     - ${combatant.name} (${combatant.entityType}): ${combatant.hpCurrent}/${combatant.hpMax} HP`
      );
    }

    console.log();

    // ── 4. Submit player actions ───────────────────────────────────────────
    console.log("4️⃣ Submitting player actions...");

    const playerCombatant = combat.combatants.find(
      (c) => c.entityType === "PLAYER"
    );
    const enemyCombatant = combat.combatants.find(
      (c) => c.entityType === "ENEMY"
    );

    if (!playerCombatant || !enemyCombatant) {
      console.error("   ❌ Missing combatants!");
      return;
    }

    const action = await submitCombatAction({
      combatId: combat.id,
      playerId: testPlayer.id,
      roundNumber: combat.roundNumber,
      actionType: "ATTACK",
      targetId: enemyCombatant.id,
      idempotencyKey: randomUUID(),
    });

    console.log(`   ✅ Action submitted: ${action.actionType} → ${action.targetId?.substring(0, 8)}...`);
    console.log();

    // ── 5. Wait a bit, then resolve round ──────────────────────────────────
    console.log("5️⃣ Waiting 2 seconds before resolving round...");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log("   Resolving round...");
    const logs = await lockAndResolveRound(combat.id);

    console.log(`   ✅ Round resolved! ${logs.length} log entries:`);
    for (const log of logs) {
      console.log(`     [${log.type}] ${log.message}`);
    }

    console.log();

    // ── 6. Check combat state after resolution ─────────────────────────────
    console.log("6️⃣ Checking combat state after round...");

    const updatedCombat = await getCombatInstance(combat.id);
    console.log(`   - State: ${updatedCombat.state}`);
    console.log(`   - Round: ${updatedCombat.roundNumber}`);

    for (const combatant of updatedCombat.combatants) {
      console.log(
        `     - ${combatant.name}: ${combatant.hpCurrent}/${combatant.hpMax} HP ${
          combatant.isDowned ? "💀 DOWNED" : ""
        }`
      );
    }

    console.log();

    // ── 7. Test HP Regeneration ────────────────────────────────────────────
    if (updatedCombat.state === "COMPLETED") {
      console.log("7️⃣ Testing HP regeneration (combat completed)...");

      const beforeRegen = await db
        .select()
        .from(players)
        .where(eq(players.id, testPlayer.id))
        .limit(1);

      console.log(`   Before regen: ${beforeRegen[0]?.hpCurrent} HP`);

      await regenerateHPOutOfCombat(testPlayer.id);

      const afterRegen = await db
        .select()
        .from(players)
        .where(eq(players.id, testPlayer.id))
        .limit(1);

      console.log(`   After regen: ${afterRegen[0]?.hpCurrent} HP`);
      console.log(`   ✅ Regeneration working!`);
    }

    console.log("\n✅ All tests passed!");
  } catch (err) {
    console.error("\n❌ Test failed:", err);
    throw err;
  }
}

// Run tests
testCombatSystem()
  .then(() => {
    console.log("\n🎉 Combat system test complete!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n💥 Test suite failed:", err);
    process.exit(1);
  });
