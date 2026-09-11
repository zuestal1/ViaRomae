import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";

const STORE_POSITION_MAX_AGE_SECONDS = 15;
const STORE_MAX_ACCURACY_M = 50;
const STORE_ACCURACY_CREDIT_M = 10;
const TEAM_INVENTORY_LIMIT = 40;

type StoreContext = {
  player_id: string; team_id: string; store_id: string; external_id: string;
  store_name: string; distance_m: string | null; interaction_radius_m: number;
  last_location_update: Date | string | null; last_location_accuracy: number | null;
  valid_location_streak: number;
};
type SqlExecutor = Pick<typeof db, "execute">;

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

/** GDD sell value: 15% of reference price, rounded to the nearest 5 Denarii. */
export function calculateStoreSellPrice(referencePrice: number): number {
  return Math.max(0, Math.round((referencePrice * 0.15) / 5) * 5);
}

async function context(executor: SqlExecutor, accountId: string, storeId: string): Promise<StoreContext> {
  const result = await executor.execute(sql`
    SELECT p.id player_id, p.team_id, p.last_location_update,
           p.last_location_accuracy, p.valid_location_streak,
           wo.id store_id, wo.external_id, wo.name store_name,
           wo.interaction_radius_m,
           CASE WHEN p.geom IS NULL OR wo.geom IS NULL THEN NULL
             ELSE ST_DistanceSphere(p.geom, wo.geom) END distance_m
      FROM player p
      JOIN world_object wo ON wo.id = ${storeId}::uuid AND wo.type = 'STORE'
     WHERE p.account_id = ${accountId}::uuid
  `);
  const row = (result.rows as StoreContext[])[0];
  if (!row) throw httpError("Store oder Spieler nicht gefunden.", 404);
  return row;
}

export function storeInteractionBlockReason(ctx: StoreContext, requireConfirmedFix = true): string | null {
  if (!ctx.last_location_update || ctx.distance_m == null || ctx.last_location_accuracy == null) {
    return "GPS-Position nicht verfügbar.";
  }
  if (ctx.last_location_accuracy > STORE_MAX_ACCURACY_M) {
    return "GPS-Genauigkeit ist schlechter als 50 m.";
  }
  if (Date.now() - new Date(ctx.last_location_update).getTime() > STORE_POSITION_MAX_AGE_SECONDS * 1000) {
    return "GPS-Position ist älter als 15 Sekunden.";
  }
  if (requireConfirmedFix && ctx.valid_location_streak < 2) {
    return "Eine zweite gültige GPS-Messung wird benötigt.";
  }
  const effective = Math.max(0, Number(ctx.distance_m) - Math.min(ctx.last_location_accuracy, STORE_ACCURACY_CREDIT_M));
  if (effective > ctx.interaction_radius_m) return `Store ist ${Math.ceil(effective)} m entfernt.`;
  return null;
}

async function balance(executor: SqlExecutor, teamId: string): Promise<number> {
  const result = await executor.execute(sql`
    SELECT COALESCE(SUM(amount), 0) balance FROM ledger_entry
     WHERE team_id = ${teamId}::uuid AND currency_type = 'DENARII'
  `);
  return Number((result.rows as { balance: string }[])[0]?.balance ?? 0);
}

export async function getStoreCatalog(accountId: string, storeId: string) {
  const ctx = await context(db, accountId, storeId);
  const catalog = await db.execute(sql`
    SELECT d.key definition_id, d.name, d.category, d.stackable, sci.price
      FROM store_catalog_item sci JOIN item_def d ON d.key = sci.definition_id
     WHERE sci.store_id = ${storeId}::uuid ORDER BY sci.price, d.name
  `);
  const blockedReason = storeInteractionBlockReason(ctx);
  return {
    storeId: ctx.store_id, externalId: ctx.external_id, name: ctx.store_name,
    denarii: await balance(db, ctx.team_id), interactionAllowed: blockedReason === null,
    blockedReason,
    items: (catalog.rows as Array<{definition_id:string; name:string; category:"EQUIPMENT"|"CONSUMABLE"; stackable:boolean; price:number}>).map(item => ({
      definitionId: item.definition_id, name: item.name, category: item.category,
      stackable: item.stackable, price: item.price, sellPrice: calculateStoreSellPrice(item.price),
    })),
  };
}

async function existingTransaction(executor: SqlExecutor, key: string) {
  const result = await executor.execute(sql`
    SELECT id transaction_id, kind, definition_id, quantity, amount, team_id
      FROM store_transaction WHERE idempotency_key = ${key}::uuid
  `);
  return (result.rows as Array<{transaction_id:string; kind:"BUY"|"SELL"; definition_id:string; quantity:number; amount:number; team_id:string}>)[0];
}

async function response(executor: SqlExecutor, row: NonNullable<Awaited<ReturnType<typeof existingTransaction>>>, alreadyProcessed: boolean) {
  return { transactionId: row.transaction_id, alreadyProcessed, kind: row.kind,
    definitionId: row.definition_id, quantity: row.quantity, amount: row.amount,
    denarii: await balance(executor, row.team_id) };
}

export async function purchaseStoreItem(accountId: string, storeId: string, input: {idempotencyKey:string; definitionId:string; quantity:number}) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`);
    const prior = await existingTransaction(tx, input.idempotencyKey);
    if (prior) return response(tx, prior, true);
    const ctx = await context(tx, accountId, storeId);
    const reason = storeInteractionBlockReason(ctx);
    if (reason) throw httpError(reason, 409);
    await tx.execute(sql`SELECT id FROM team WHERE id = ${ctx.team_id}::uuid FOR UPDATE`);
    const catalog = await tx.execute(sql`
      SELECT sci.price, d.key, d.category, d.equip_slot, d.stackable
        FROM store_catalog_item sci JOIN item_def d ON d.key = sci.definition_id
       WHERE sci.store_id = ${storeId}::uuid AND sci.definition_id = ${input.definitionId}
    `);
    const item = (catalog.rows as Array<{price:number;key:string;category:string;equip_slot:string|null;stackable:boolean}>)[0];
    if (!item) throw httpError("Artikel gehört nicht zum Sortiment dieses Stores.", 404);
    const total = item.price * input.quantity;
    if (await balance(tx, ctx.team_id) < total) throw httpError("Nicht genügend Denare.", 409);
    const count = await tx.execute(sql`SELECT COALESCE(SUM(quantity),0) total FROM item_instance WHERE owner_type='TEAM' AND owner_id=${ctx.team_id}::uuid`);
    if (Number((count.rows as {total:string}[])[0]?.total ?? 0) + input.quantity > TEAM_INVENTORY_LIMIT) throw httpError("Team-Inventar ist voll.", 409);
    if (item.stackable) {
      const updated = await tx.execute(sql`UPDATE item_instance SET quantity=quantity+${input.quantity} WHERE owner_type='TEAM' AND owner_id=${ctx.team_id}::uuid AND definition_id=${item.key} RETURNING id`);
      if (!updated.rows.length) await tx.execute(sql`INSERT INTO item_instance (id,definition_id,owner_type,owner_id,quantity,category,slot,is_equipped,is_bound,is_quest_locked) VALUES (gen_random_uuid(),${item.key},'TEAM',${ctx.team_id}::uuid,${input.quantity},${item.category}::item_category,${item.equip_slot}::item_slot,false,false,false)`);
    } else {
      await tx.execute(sql`INSERT INTO item_instance (id,definition_id,owner_type,owner_id,quantity,category,slot,is_equipped,is_bound,is_quest_locked) SELECT gen_random_uuid(),${item.key},'TEAM',${ctx.team_id}::uuid,1,${item.category}::item_category,${item.equip_slot}::item_slot,false,false,false FROM generate_series(1,${input.quantity})`);
    }
    await tx.execute(sql`INSERT INTO ledger_entry (id,team_id,player_id,currency_type,amount,source,idempotency_key) VALUES(gen_random_uuid(),${ctx.team_id}::uuid,${ctx.player_id}::uuid,'DENARII',${-total},'STORE',${input.idempotencyKey}::uuid)`);
    const inserted = await tx.execute(sql`INSERT INTO store_transaction(id,idempotency_key,store_id,team_id,player_id,kind,definition_id,quantity,amount) VALUES(gen_random_uuid(),${input.idempotencyKey}::uuid,${storeId}::uuid,${ctx.team_id}::uuid,${ctx.player_id}::uuid,'BUY',${item.key},${input.quantity},${-total}) RETURNING id transaction_id,kind,definition_id,quantity,amount,team_id`);
    return response(tx, inserted.rows[0] as NonNullable<Awaited<ReturnType<typeof existingTransaction>>>, false);
  });
}

export async function sellStoreItem(accountId:string, storeId:string, input:{idempotencyKey:string;itemInstanceId:string;quantity:number}) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`);
    const prior = await existingTransaction(tx, input.idempotencyKey);
    if (prior) return response(tx, prior, true);
    const ctx = await context(tx, accountId, storeId);
    const reason = storeInteractionBlockReason(ctx); if (reason) throw httpError(reason,409);
    await tx.execute(sql`SELECT id FROM team WHERE id=${ctx.team_id}::uuid FOR UPDATE`);
    const found = await tx.execute(sql`SELECT i.*, d.buy_price FROM item_instance i JOIN item_def d ON d.key=i.definition_id WHERE i.id=${input.itemInstanceId}::uuid AND i.owner_type='TEAM' AND i.owner_id=${ctx.team_id}::uuid FOR UPDATE`);
    const item = (found.rows as Array<{definition_id:string;quantity:number;is_equipped:boolean;is_bound:boolean;is_quest_locked:boolean;buy_price:number|null}>)[0];
    if (!item) throw httpError("Gegenstand nicht im Team-Inventar gefunden.",404);
    if (item.is_equipped || item.is_bound || item.is_quest_locked) throw httpError("Gebundene, Quest- oder ausgerüstete Gegenstände können nicht verkauft werden.",409);
    if (item.quantity < input.quantity) throw httpError("Nicht genügend Gegenstände vorhanden.",409);
    if (item.buy_price == null) throw httpError("Für diesen Gegenstand existiert kein Referenzpreis.",409);
    const unitPrice=calculateStoreSellPrice(item.buy_price); const total=unitPrice*input.quantity;
    if (item.quantity === input.quantity) await tx.execute(sql`DELETE FROM item_instance WHERE id=${input.itemInstanceId}::uuid`);
    else await tx.execute(sql`UPDATE item_instance SET quantity=quantity-${input.quantity} WHERE id=${input.itemInstanceId}::uuid`);
    await tx.execute(sql`INSERT INTO ledger_entry(id,team_id,player_id,currency_type,amount,source,idempotency_key) VALUES(gen_random_uuid(),${ctx.team_id}::uuid,${ctx.player_id}::uuid,'DENARII',${total},'STORE',${input.idempotencyKey}::uuid)`);
    const inserted=await tx.execute(sql`INSERT INTO store_transaction(id,idempotency_key,store_id,team_id,player_id,kind,definition_id,quantity,amount) VALUES(gen_random_uuid(),${input.idempotencyKey}::uuid,${storeId}::uuid,${ctx.team_id}::uuid,${ctx.player_id}::uuid,'SELL',${item.definition_id},${input.quantity},${total}) RETURNING id transaction_id,kind,definition_id,quantity,amount,team_id`);
    return response(tx, inserted.rows[0] as NonNullable<Awaited<ReturnType<typeof existingTransaction>>>, false);
  });
}
