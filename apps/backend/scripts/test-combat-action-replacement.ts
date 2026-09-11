/** Integration test. Requires a migrated, disposable DATABASE_URL. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { combatActions, combatActionSubmissions, combatants, combatInstances } from "../src/db/schema/combat.js";
import { lockAndResolveRound, submitCombatAction } from "../src/modules/combat/combat.service.js";

const combats: string[] = [];
try {
  const combatId = randomUUID();
  combats.push(combatId);
  const playerId = randomUUID();
  const actorId = randomUUID();
  const enemyId = randomUUID();
  await db.insert(combatInstances).values({ id: combatId, type: "PVE", state: "AWAITING_ACTIONS", roundNumber: 1, actionDeadline: new Date(Date.now() + 15_000) });
  await db.insert(combatants).values([
    { id: actorId, combatInstanceId: combatId, entityType: "PLAYER", entityId: playerId, hpCurrent: 120 },
    { id: enemyId, combatInstanceId: combatId, entityType: "ENEMY", entityId: randomUUID(), hpCurrent: 90 },
  ]);

  const firstKey = randomUUID();
  const first = await submitCombatAction({ combatId, playerId, roundNumber: 1, actionType: "ATTACK", targetId: enemyId, idempotencyKey: firstKey });
  const replacement = await submitCombatAction({ combatId, playerId, roundNumber: 1, actionType: "ATTACK", targetId: enemyId, idempotencyKey: randomUUID() });
  assert.equal(replacement.id, first.id);
  assert.equal(replacement.actionType, "ATTACK");
  const retry = await submitCombatAction({ combatId, playerId, roundNumber: 1, actionType: "ATTACK", targetId: enemyId, idempotencyKey: firstKey });
  assert.equal(retry.actionType, "ATTACK", "the original request receipt must be replayed");
  const [current] = await db.select().from(combatActions).where(eq(combatActions.id, first.id));
  assert.equal(current?.actionType, "ATTACK", "an old retry must not replace the latest accepted action");

  await db.update(combatInstances).set({ state: "LOCKED" }).where(eq(combatInstances.id, combatId));
  await assert.rejects(
    submitCombatAction({ combatId, playerId, roundNumber: 1, actionType: "ATTACK", targetId: enemyId, idempotencyKey: randomUUID() }),
    /not accepting actions/
  );

  const automaticCombatId = randomUUID();
  combats.push(automaticCombatId);
  const automaticPlayerId = randomUUID();
  const automaticActorId = randomUUID();
  const automaticEnemyId = randomUUID();
  await db.insert(combatInstances).values({ id: automaticCombatId, type: "PVE", state: "AWAITING_ACTIONS", roundNumber: 1, actionDeadline: new Date(Date.now() + 15_000) });
  await db.insert(combatants).values([
    { id: automaticActorId, combatInstanceId: automaticCombatId, entityType: "PLAYER", entityId: automaticPlayerId, hpCurrent: 100 }, // Bildhauer 100/11/10/8
    { id: automaticEnemyId, combatInstanceId: automaticCombatId, entityType: "ENEMY", entityId: randomUUID(), hpCurrent: 100 }, // Condottiere 100/14/8/12
  ]);
  await lockAndResolveRound(automaticCombatId);
  const [automatic] = await db.select().from(combatActions).where(and(
    eq(combatActions.combatInstanceId, automaticCombatId),
    eq(combatActions.roundNumber, 1),
    eq(combatActions.actorId, automaticActorId)
  ));
  assert.equal(automatic?.actionType, "ATTACK");
  assert.equal(automatic?.origin, "AUTOMATIC");
  assert.equal(automatic?.targetId, automaticEnemyId);
  assert.equal(automatic?.isLocked, true);
  console.log("combat action replacement integration tests passed");
} finally {
  if (combats.length) {
    await db.delete(combatActionSubmissions).where(eq(combatActionSubmissions.combatInstanceId, combats[0]!));
    for (const id of combats) await db.delete(combatInstances).where(eq(combatInstances.id, id));
  }
}
process.exit(0);
