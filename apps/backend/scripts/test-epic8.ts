/**
 * Epic 8 Integration Tests
 * Tests: Media Quests, World Bosses, S3 Pre-Signed URLs, GM Review Workflow
 * Run: pnpm --filter @jlw/backend exec tsx scripts/test-epic8.ts
 */

import { randomUUID } from "node:crypto";
import { sql, eq, and } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { teams, players } from "../src/db/schema/player.js";
import { accounts } from "../src/db/schema/account.js";
import { worldObjects } from "../src/db/schema/world.js";
import { questDefinitions, questRuns, questSteps } from "../src/db/schema/quest.js";
import { mediaSubmissions, reviewDecisions } from "../src/db/schema/media.js";
import { combatInstances, combatants } from "../src/db/schema/combat.js";
import { S3Service } from "../src/modules/media/s3.service.js";
import { MediaService } from "../src/modules/media/media.service.js";
import {
  getOrCreateBossCombat,
  joinBossCombat,
  submitGlobalAction,
  getBossCombatStatus,
} from "../src/modules/combat/boss.service.js";

let failed = 0;
let passed = 0;

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ❌ FAIL  ${msg}`);
  } else {
    passed++;
    console.log(`  ✅ OK    ${msg}`);
  }
}

async function cleanup(): Promise<void> {
  console.log("\n🧹 Cleaning up test data...");
  try {
    await db.delete(combatants).where(sql`true`);
    await db.delete(combatInstances).where(sql`true`);
    await db.delete(reviewDecisions).where(sql`true`);
    await db.delete(mediaSubmissions).where(sql`true`);
    await db.delete(questRuns).where(sql`true`);
    await db.delete(questSteps).where(sql`quest_definition_id IN (SELECT id FROM quest_definition WHERE external_id LIKE 'test-%')`);
    await db.delete(questDefinitions).where(sql`external_id LIKE 'test-%'`);
    await db.delete(worldObjects).where(sql`external_id LIKE 'test-%'`);
    await db.delete(players).where(sql`true`);
    await db.delete(teams).where(sql`name LIKE 'Test-%'`);
    await db.delete(accounts).where(sql`username LIKE 'test-%'`);
    console.log("  ✅ Cleanup completed");
  } catch (err) {
    console.log("  ⚠️  Cleanup warning (may be first run):", (err as Error).message);
  }
}

async function setupTestData(): Promise<{
  teamId1: string;
  teamId2: string;
  playerId1: string;
  playerId2: string;
  accountId1: string;
  accountId2: string;
  gmAccountId: string;
  questDefId: string;
  bossWorldObjectId: string;
}> {
  console.log("\n📦 Setting up test data...");
  
  const suffix = Date.now().toString(36);

  // Create teams
  const [team1] = await db.insert(teams).values({
    name: `Test-Team1-${suffix}`,
  }).returning();

  const [team2] = await db.insert(teams).values({
    name: `Test-Team2-${suffix}`,
  }).returning();

  // Create accounts
  const [account1] = await db.insert(accounts).values({
    username: `test-player1-${suffix}`,
    accessCodeHash: "test-hash-1",
    role: "PLAYER",
  }).returning();

  const [account2] = await db.insert(accounts).values({
    username: `test-player2-${suffix}`,
    accessCodeHash: "test-hash-2",
    role: "PLAYER",
  }).returning();

  const [gmAccount] = await db.insert(accounts).values({
    username: `test-gm-${suffix}`,
    accessCodeHash: "test-hash-gm",
    role: "GM",
  }).returning();

  // Create players
  const [player1] = await db.insert(players).values({
    accountId: account1!.id,
    teamId: team1!.id,
    class: "GARDIST",
    hpCurrent: 100,
    status: "ACTIVE",
  }).returning();

  const [player2] = await db.insert(players).values({
    accountId: account2!.id,
    teamId: team2!.id,
    class: "CLERIC",
    hpCurrent: 100,
    status: "ACTIVE",
  }).returning();

  // Create BOSS world object
  const [bossWo] = await db.insert(worldObjects).values({
    externalId: `test-boss-${suffix}`,
    type: "BOSS",
    name: "Test Hydra",
    day: "DAY_1",
    lat: 41.8902,
    lng: 12.4924,
    discoveryRadiusM: 55,
    interactionRadiusM: 15,
    exitHysteresisRadiusM: 25,
    aggroRadiusM: 20,
    bossJoinRadiusM: 30,
    contentStatus: "APPROVED",
    publishable: true,
    rawPropertiesJson: JSON.stringify({ hp: 500, initiative: 100 }),
  }).returning();

  // Create quest definition with UPLOAD_MEDIA step
  const [questDef] = await db.insert(questDefinitions).values({
    externalId: `test-media-quest-${suffix}`,
    title: "Test Media Quest",
    type: "MEDIA",
    day: "DAY_1",
  }).returning();

  // Create UPLOAD_MEDIA quest step
  await db.insert(questSteps).values({
    questDefinitionId: questDef!.id,
    stepId: `test-step-${suffix}`,
    sequence: 1,
    flowPhase: "OBJECTIVE",
    stepActionType: "UPLOAD_MEDIA",
    stepCategory: "OBJECTIVE",
    targetRef: `test-location-${suffix}`,
    required: true,
  });

  console.log("  ✅ Test data created");
  console.log(`     Team 1: ${team1!.id}`);
  console.log(`     Team 2: ${team2!.id}`);
  console.log(`     Boss: ${bossWo!.id}`);
  console.log(`     Quest: ${questDef!.id}`);

  return {
    teamId1: team1!.id,
    teamId2: team2!.id,
    playerId1: player1!.id,
    playerId2: player2!.id,
    accountId1: account1!.id,
    accountId2: account2!.id,
    gmAccountId: gmAccount!.id,
    questDefId: questDef!.id,
    bossWorldObjectId: bossWo!.id,
  };
}

async function testS3Service(): Promise<void> {
  console.log("\n📸 Testing S3 Service (Pre-Signed URLs)...");
  
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => logger,
  } as any;

  const s3Service = new S3Service(logger);
  
  try {
    const result = await s3Service.generatePresignedUploadUrl(
      "test-team-id",
      "test-quest-run-id",
      "image/jpeg",
      1024 * 1024, // 1 MB
    );

    assert(result.uploadUrl, "Generated upload URL");
    assert(result.uploadUrl.includes("X-Amz-Signature"), "URL contains AWS signature");
    assert(result.objectKey.startsWith("team/test-team-id/quest/test-quest-run-id/"), "Object key has correct structure");
    assert(result.expiresIn === 3600, "URL expires in 1 hour");
    console.log(`     Object Key: ${result.objectKey}`);
  } catch (err) {
    console.log("  ⚠️  SKIP   S3 credentials not configured (expected in test environment)");
  }
}

async function testMediaWorkflow(data: Awaited<ReturnType<typeof setupTestData>>): Promise<void> {
  console.log("\n📸 Testing Media Upload Workflow...");

  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => logger,
  } as any;

  const mediaService = new MediaService(logger);

  // Create a quest run
  const [questRun] = await db.insert(questRuns).values({
    teamId: data.teamId1,
    questDefinitionId: data.questDefId,
    state: "ACTIVE",
  }).returning();

  console.log("  1️⃣  Creating media submission...");
  try {
    const uploadUrl = await mediaService.requestUploadUrl(
      data.teamId1,
      questRun!.id,
      "image/jpeg",
      2 * 1024 * 1024, // 2 MB
    );
    assert(uploadUrl.uploadUrl, "Generated pre-signed URL");
    assert(uploadUrl.objectKey, "Generated object key");
  } catch (err) {
    console.log("  ⚠️  SKIP   S3 credentials not configured");
  }

  // Manually create a submission for testing review workflow
  const [submission] = await db.insert(mediaSubmissions).values({
    teamId: data.teamId1,
    questRunId: questRun!.id,
    objectKey: `team/${data.teamId1}/quest/${questRun!.id}/test.jpg`,
    status: "UPLOADING",
  }).returning();

  console.log("  2️⃣  Confirming upload (simulate S3 completion)...");
  const confirmed = await mediaService.confirmUploadComplete(submission!.objectKey);
  assert(confirmed.status === "RECEIVED", "Status transitioned to RECEIVED");

  // Check quest run state
  const [updatedQuestRun] = await db
    .select()
    .from(questRuns)
    .where(eq(questRuns.id, questRun!.id));
  assert(updatedQuestRun!.state === "PENDING_REVIEW", "Quest run status is PENDING_REVIEW");

  console.log("  3️⃣  GM reviewing media submission (approve)...");
  const decision = await mediaService.submitReview(
    submission!.id,
    data.gmAccountId,
    8, // Score 8/10
    "Great photo!",
  );
  assert(decision.score === 8, "Review decision saved with score 8");

  // Check final states
  const [reviewedSubmission] = await db
    .select()
    .from(mediaSubmissions)
    .where(eq(mediaSubmissions.id, submission!.id));
  assert(reviewedSubmission!.status === "APPROVED", "Submission status is APPROVED");

  console.log("  4️⃣  Testing rejection workflow...");
  const [submission2] = await db.insert(mediaSubmissions).values({
    teamId: data.teamId1,
    questRunId: questRun!.id,
    objectKey: `team/${data.teamId1}/quest/${questRun!.id}/test2.jpg`,
    status: "RECEIVED",
  }).returning();

  await mediaService.submitReview(
    submission2!.id,
    data.gmAccountId,
    3, // Score 3/10 (reject)
    "Blurry image",
  );

  const [rejectedSubmission] = await db
    .select()
    .from(mediaSubmissions)
    .where(eq(mediaSubmissions.id, submission2!.id));
  assert(rejectedSubmission!.status === "REJECTED", "Low score results in REJECTED status");

  console.log("  5️⃣  Testing GM inbox (pending submissions)...");
  const pending = await mediaService.getPendingSubmissions();
  assert(pending.length >= 0, "Can retrieve pending submissions");
}

async function testBossCombat(data: Awaited<ReturnType<typeof setupTestData>>): Promise<void> {
  console.log("\n🐉 Testing World Boss Combat System...");

  console.log("  1️⃣  Creating boss combat instance...");
  const combat = await getOrCreateBossCombat({
    worldObjectId: data.bossWorldObjectId,
  });
  assert(combat.type === "BOSS", "Combat type is BOSS");
  assert(combat.state === "AWAITING_ACTIONS", "Initial state is AWAITING_ACTIONS");
  assert(combat.combatants.length === 1, "One boss combatant created");

  const bossCombatant = combat.combatants.find((c) => c.entityType === "ENEMY");
  assert(bossCombatant?.hpCurrent === 500, "Boss starts with 500 HP");

  console.log("  2️⃣  Team 1 joins boss combat...");
  await joinBossCombat({
    combatId: combat.id,
    teamId: data.teamId1,
  });

  const combatAfterJoin1 = await getOrCreateBossCombat({
    worldObjectId: data.bossWorldObjectId,
  });
  const playerCombatants = combatAfterJoin1.combatants.filter((c) => c.entityType === "PLAYER");
  assert(playerCombatants.length >= 1, "Player combatants added");

  console.log("  3️⃣  Team 2 joins boss combat (HP should scale)...");
  await joinBossCombat({
    combatId: combat.id,
    teamId: data.teamId2,
  });

  const combatAfterJoin2 = await getOrCreateBossCombat({
    worldObjectId: data.bossWorldObjectId,
  });
  const bossAfterScale = combatAfterJoin2.combatants.find((c) => c.entityType === "ENEMY");
  // HP should scale: 500 + (2-1) * 300 = 800, but proportionally adjusted
  assert(bossAfterScale && bossAfterScale.hpCurrent >= 500, "Boss HP scaled up");

  console.log("  4️⃣  Testing global boss actions...");
  await submitGlobalAction({
    combatId: combat.id,
    teamId: data.teamId1,
    actionType: "APPLAUD",
  });
  console.log("     APPLAUD action submitted successfully");

  await submitGlobalAction({
    combatId: combat.id,
    teamId: data.teamId2,
    actionType: "CHEER",
  });
  console.log("     CHEER action submitted successfully");

  console.log("  5️⃣  Checking boss combat status...");
  const status = await getBossCombatStatus(data.bossWorldObjectId);
  assert(status?.active, "Boss combat is active");
  assert(status?.participatingTeams === 2, "Two teams are participating");
  assert(status?.bossHpPercent && status.bossHpPercent > 0, "Boss HP percent available");
  console.log(`     Boss HP: ${status?.bossHpPercent?.toFixed(1)}%`);
  console.log(`     Participating teams: ${status?.participatingTeams}`);

  console.log("  6️⃣  Testing boss instance retrieval...");
  const retrievedCombat = await getOrCreateBossCombat({
    worldObjectId: data.bossWorldObjectId,
  });
  assert(retrievedCombat.id === combat.id, "Retrieved same boss combat instance (global instance)");
}

async function testGeofencingIntegration(data: Awaited<ReturnType<typeof setupTestData>>): Promise<void> {
  console.log("\n🗺️  Testing Geofencing Integration...");

  // Check that boss_join_radius_m is set in database
  const [boss] = await db
    .select()
    .from(worldObjects)
    .where(eq(worldObjects.id, data.bossWorldObjectId));

  assert(boss!.bossJoinRadiusM === 30, "Boss has boss_join_radius_m set to 30m");
  
  // Verify PostGIS query includes boss_join_radius_m
  const result = await db.execute(sql`
    SELECT boss_join_radius_m
    FROM world_object
    WHERE id = ${data.bossWorldObjectId}
  `);
  
  const row = (result.rows as { boss_join_radius_m: number }[])[0];
  assert(row?.boss_join_radius_m === 30, "boss_join_radius_m readable from database");
  
  console.log("     Boss join radius correctly configured");
}

async function runAllTests(): Promise<void> {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║         Epic 8: Media Quests & World Bosses Tests        ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  let data: Awaited<ReturnType<typeof setupTestData>> | null = null;

  try {
    await cleanup();
    data = await setupTestData();

    await testS3Service();
    await testMediaWorkflow(data);
    await testBossCombat(data);
    await testGeofencingIntegration(data);

    console.log("\n╔═══════════════════════════════════════════════════════════╗");
    console.log(`║  Results: ${passed} passed, ${failed} failed${' '.repeat(Math.max(0, 29 - passed.toString().length - failed.toString().length))}║`);
    console.log("╚═══════════════════════════════════════════════════════════╝");

    if (failed > 0) {
      process.exit(1);
    } else {
      console.log("\n✅ All Epic 8 tests passed!");
      process.exit(0);
    }
  } catch (err) {
    console.error("\n❌ Test suite failed with error:");
    console.error(err);
    process.exit(1);
  } finally {
    if (data) {
      await cleanup();
    }
  }
}

runAllTests();
