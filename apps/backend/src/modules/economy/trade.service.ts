import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { INVENTORY_LIMITS, normalizeTradeItems } from "./item-rules.js";

export type TradeItem = { itemInstanceId: string; quantity: number };
export type TradeCurrency = { currencyType: "DENARII" | "FAME"; amount: number };

export type TradeSide = {
  items: TradeItem[];
  denarii: number;
};

export type TradeOfferRow = {
  id: string;
  status: "OPEN" | "ACCEPTED" | "REJECTED" | "CANCELLED";
  initiatorTeamId: string;
  counterpartyTeamId: string;
  initiatorName: string;
  counterpartyName: string;
  initiatorPayload: TradeSide & { itemLabels?: string[] };
  counterpartyPayload: (TradeSide & { itemLabels?: string[] }) | null;
  createdAt: string;
};

type Tx = { execute: typeof db.execute };

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function isEmptySide(side: TradeSide): boolean {
  const items = side.items?.filter((i) => i.quantity > 0) ?? [];
  return items.length === 0 && (side.denarii ?? 0) <= 0;
}

function currenciesFromSide(side: TradeSide): TradeCurrency[] {
  if ((side.denarii ?? 0) <= 0) return [];
  return [{ currencyType: "DENARII", amount: side.denarii }];
}

async function assertTradeAvailable(tx:Tx, firstTeamId:string, secondTeamId:string) {
  const result=await tx.execute(sql`SELECT EXISTS(
    SELECT 1 FROM player a CROSS JOIN player b
    WHERE a.team_id=${firstTeamId}::uuid AND b.team_id=${secondTeamId}::uuid
      AND a.geom IS NOT NULL AND b.geom IS NOT NULL
      AND a.last_location_update>now()-interval '15 seconds'
      AND b.last_location_update>now()-interval '15 seconds'
      AND ST_DistanceSphere(a.geom,b.geom)<=15
  ) nearby,
  EXISTS(SELECT 1 FROM combat_instance ci JOIN combatant c ON c.combat_instance_id=ci.id
    WHERE c.team_id IN (${firstTeamId}::uuid,${secondTeamId}::uuid) AND ci.state<>'COMPLETED') in_combat,
  EXISTS(SELECT 1 FROM pvp_challenge p WHERE (p.attacker_team_id IN (${firstTeamId}::uuid,${secondTeamId}::uuid)
    OR p.defender_team_id IN (${firstTeamId}::uuid,${secondTeamId}::uuid)) AND p.state='WARNING') in_pvp`);
  const state=result.rows[0] as {nearby:boolean;in_combat:boolean;in_pvp:boolean};
  if(!state.nearby) throw httpError("Teams must be within 15 metres to trade",409);
  if(state.in_combat || state.in_pvp) throw httpError("Trading is unavailable during combat or a PvP warning",409);
}

async function assertOwnsBundle(
  tx: Tx,
  teamId: string,
  side: TradeSide,
): Promise<void> {
  for (const it of side.items) {
    if (it.quantity <= 0) continue;
    const r = await tx.execute(sql`
      SELECT quantity, owner_id, owner_type, is_bound, is_equipped, is_quest_locked, category
      FROM item_instance
      WHERE id = ${it.itemInstanceId}::uuid
      FOR UPDATE
    `);
    const row = (r.rows as {
      quantity: number;
      owner_id: string;
      owner_type: string;
      is_bound:boolean; is_equipped:boolean; is_quest_locked:boolean; category:string;
    }[])[0];
    if (!row) throw httpError("Item not found", 404);
    if (row.owner_type !== "TEAM" || row.owner_id !== teamId) {
      throw httpError("Item not owned by this team", 403);
    }
    if (Number(row.quantity) < it.quantity) {
      throw httpError("Insufficient item quantity", 409);
    }
    if (row.is_bound || row.is_equipped || row.is_quest_locked || row.category === "QUEST") {
      throw httpError("Bound, equipped and quest items cannot be traded", 409);
    }
  }
  if (side.denarii > 0) {
    const balRes = await tx.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS bal
      FROM ledger_entry
      WHERE team_id = ${teamId}::uuid AND currency_type = 'DENARII'
    `);
    const bal = Number((balRes.rows as { bal: string }[])[0]?.bal ?? 0);
    if (bal < side.denarii) throw httpError("Insufficient funds", 409);
  }
}

async function transferBundle(
  tx: Tx,
  senderTeamId: string,
  receiverTeamId: string,
  side: TradeSide,
): Promise<void> {
  const items = side.items.filter((i) => i.quantity > 0);
  for (const it of items) {
    const r = await tx.execute(sql`
      SELECT quantity, definition_id
      FROM item_instance
      WHERE id = ${it.itemInstanceId}::uuid
      FOR UPDATE
    `);
    const row = (r.rows as { quantity: number; definition_id: string }[])[0];
    if (!row) throw httpError("Item not found", 404);
    const remaining = Number(row.quantity) - it.quantity;
    const defKey = row.definition_id;

    if (remaining > 0) {
      await tx.execute(sql`
        UPDATE item_instance SET quantity = ${remaining}
        WHERE id = ${it.itemInstanceId}::uuid
      `);
      const defRes = await tx.execute(sql`
        SELECT stackable, equip_slot AS slot, category,max_stack
        FROM item_def WHERE key = ${defKey}
      `);
      const def = (defRes.rows as { stackable: boolean; slot: string | null; category: string;max_stack:number }[])[0];
      if (def?.stackable) {
        const upd = await tx.execute(sql`
          UPDATE item_instance
          SET quantity = quantity + ${it.quantity}
          WHERE owner_type = 'TEAM'::owner_type
            AND owner_id = ${receiverTeamId}::uuid
            AND definition_id = ${defKey}
            AND quantity + ${it.quantity} <= ${def.max_stack}
          RETURNING id
        `);
        if (upd.rows.length === 0) {
          await tx.execute(sql`
            INSERT INTO item_instance
              (id, definition_id, owner_type, owner_id, quantity, category, slot, is_equipped, is_bound)
            VALUES (
              gen_random_uuid(), ${defKey}, 'TEAM'::owner_type, ${receiverTeamId}::uuid,
              ${it.quantity}, ${def.category}::item_category, ${def.slot}::item_slot, false, false
            )
          `);
        }
      } else {
        for (let k = 0; k < it.quantity; k++) {
          await tx.execute(sql`
            INSERT INTO item_instance
              (id, definition_id, owner_type, owner_id, quantity, category, slot, is_equipped, is_bound)
            VALUES (
              gen_random_uuid(), ${defKey}, 'TEAM'::owner_type, ${receiverTeamId}::uuid,
              1, ${def?.category ?? "EQUIPMENT"}::item_category, ${def?.slot ?? null}::item_slot, false, false
            )
          `);
        }
      }
    } else {
      await tx.execute(sql`
        UPDATE item_instance
        SET owner_id = ${receiverTeamId}::uuid,
            owner_type = 'TEAM'::owner_type,
            is_equipped = false
        WHERE id = ${it.itemInstanceId}::uuid
      `);
    }
  }

  for (const cur of currenciesFromSide(side)) {
    await tx.execute(sql`
      INSERT INTO ledger_entry
        (id, team_id, player_id, currency_type, amount, source, idempotency_key, created_at)
      VALUES (
        gen_random_uuid(), ${senderTeamId}::uuid, NULL,
        ${cur.currencyType}::currency_type, ${-cur.amount},
        'TRADE'::ledger_source, gen_random_uuid(), now()
      )
    `);
    await tx.execute(sql`
      INSERT INTO ledger_entry
        (id, team_id, player_id, currency_type, amount, source, idempotency_key, created_at)
      VALUES (
        gen_random_uuid(), ${receiverTeamId}::uuid, NULL,
        ${cur.currencyType}::currency_type, ${cur.amount},
        'TRADE'::ledger_source, gen_random_uuid(), now()
      )
    `);
  }
}

async function enrichLabels(side: TradeSide): Promise<string[]> {
  const labels: string[] = [];
  for (const it of side.items) {
    const r = await db.execute(sql`
      SELECT d.name, i.definition_id
      FROM item_instance i
      LEFT JOIN item_def d ON d.key = i.definition_id
      WHERE i.id = ${it.itemInstanceId}::uuid
    `);
    const row = (r.rows as { name: string | null; definition_id: string }[])[0];
    const name = row?.name ?? row?.definition_id ?? "Item";
    labels.push(`${it.quantity}× ${name}`);
  }
  if (side.denarii > 0) labels.push(`${side.denarii} Denare`);
  return labels;
}

function parseSide(raw: unknown): TradeSide & { itemLabels?: string[] } {
  const obj = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown> | null);
  return {
    items: (obj?.["items"] as TradeItem[]) ?? [],
    denarii: Number(obj?.["denarii"] ?? 0),
    itemLabels: (obj?.["itemLabels"] as string[]) ?? [],
  };
}

function mapOffer(row: Record<string, unknown>): TradeOfferRow {
  const created = row["created_at"];
  return {
    id: String(row["id"]),
    status: row["status"] as TradeOfferRow["status"],
    initiatorTeamId: String(row["initiator_team_id"]),
    counterpartyTeamId: String(row["counterparty_team_id"]),
    initiatorName: String(row["initiator_name"] ?? ""),
    counterpartyName: String(row["counterparty_name"] ?? ""),
    initiatorPayload: parseSide(row["initiator_payload"]),
    counterpartyPayload: row["counterparty_payload"]
      ? parseSide(row["counterparty_payload"])
      : null,
    createdAt:
      created instanceof Date ? created.toISOString() : String(created ?? ""),
  };
}

export async function createTradeOffer(opts: {
  initiatorTeamId: string;
  counterpartyTeamId: string;
  side: TradeSide;
}): Promise<TradeOfferRow> {
  const { initiatorTeamId, counterpartyTeamId, side } = opts;
  if (initiatorTeamId === counterpartyTeamId) {
    throw httpError("Cannot trade with your own team", 400);
  }
  const clean: TradeSide = {
    items: normalizeTradeItems(side.items.filter((i) => i.quantity > 0)),
    denarii: Math.max(0, Math.floor(side.denarii || 0)),
  };
  if (isEmptySide(clean)) throw httpError("Offer cannot be empty", 400);

  const itemLabels = await enrichLabels(clean);
  const payload = { ...clean, itemLabels };

  const inserted = await db.transaction(async (tx) => {
    await assertTradeAvailable(tx,initiatorTeamId,counterpartyTeamId);
    await assertOwnsBundle(tx, initiatorTeamId, clean);
    const res = await tx.execute(sql`
      INSERT INTO trade_offer (
        id, status, initiator_team_id, counterparty_team_id, initiator_payload
      ) VALUES (
        gen_random_uuid(), 'OPEN', ${initiatorTeamId}::uuid, ${counterpartyTeamId}::uuid,
        ${JSON.stringify(payload)}::jsonb
      )
      RETURNING id
    `);
    return String((res.rows as { id: string }[])[0]?.id);
  });
  const listed = await getOfferById(inserted);
  if (!listed) throw httpError("Failed to create offer", 500);
  return listed;
}

export async function listTradeOffers(teamId: string): Promise<{
  incoming: TradeOfferRow[];
  outgoing: TradeOfferRow[];
}> {
  const res = await db.execute(sql`
    SELECT o.*,
           ti.name AS initiator_name,
           tc.name AS counterparty_name
    FROM trade_offer o
    JOIN team ti ON ti.id = o.initiator_team_id
    JOIN team tc ON tc.id = o.counterparty_team_id
    WHERE o.status = 'OPEN'
      AND (o.initiator_team_id = ${teamId}::uuid OR o.counterparty_team_id = ${teamId}::uuid)
    ORDER BY o.created_at DESC
  `);
  const rows = (res.rows as Record<string, unknown>[]).map(mapOffer);
  return {
    incoming: rows.filter((o) => o.counterpartyTeamId === teamId),
    outgoing: rows.filter((o) => o.initiatorTeamId === teamId),
  };
}

async function getOfferById(id: string): Promise<TradeOfferRow | null> {
  const res = await db.execute(sql`
    SELECT o.*,
           ti.name AS initiator_name,
           tc.name AS counterparty_name
    FROM trade_offer o
    JOIN team ti ON ti.id = o.initiator_team_id
    JOIN team tc ON tc.id = o.counterparty_team_id
    WHERE o.id = ${id}::uuid
  `);
  const row = (res.rows as Record<string, unknown>[])[0];
  return row ? mapOffer(row) : null;
}

export async function acceptTradeOffer(opts: {
  offerId: string;
  teamId: string;
  counterSide: TradeSide;
}): Promise<TradeOfferRow> {
  const counter: TradeSide = {
    items: normalizeTradeItems(opts.counterSide.items.filter((i) => i.quantity > 0)),
    denarii: Math.max(0, Math.floor(opts.counterSide.denarii || 0)),
  };
  if (isEmptySide(counter)) {
    throw httpError("Gegenseite darf nicht leer sein – sonst wäre es ein Geschenk.", 400);
  }

  await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT * FROM trade_offer WHERE id = ${opts.offerId}::uuid FOR UPDATE
    `);
    const offer = (locked.rows as {
      status: string;
      initiator_team_id: string;
      counterparty_team_id: string;
      initiator_payload: TradeSide;
    }[])[0];
    if (!offer) throw httpError("Offer not found", 404);
    if (offer.status !== "OPEN") throw httpError("Offer is no longer open", 409);
    if (offer.counterparty_team_id !== opts.teamId) {
      throw httpError("Only the other team can accept this offer", 403);
    }

    const initiatorSide: TradeSide = {
      items: normalizeTradeItems(offer.initiator_payload.items ?? []),
      denarii: offer.initiator_payload.denarii ?? 0,
    };

    const [a, b] = [offer.initiator_team_id, offer.counterparty_team_id].sort();
    await tx.execute(sql`
      SELECT id FROM team WHERE id IN (${a}::uuid, ${b}::uuid) FOR UPDATE
    `);
    await assertTradeAvailable(tx,offer.initiator_team_id,offer.counterparty_team_id);

    await assertOwnsBundle(tx, offer.initiator_team_id, initiatorSide);
    await assertOwnsBundle(tx, offer.counterparty_team_id, counter);

    const capacity = async (teamId:string, incoming:TradeSide, outgoing:TradeSide) => {
      const result=await tx.execute(sql`SELECT COALESCE(SUM(quantity),0) total FROM item_instance
        WHERE owner_type='TEAM' AND owner_id=${teamId}::uuid AND category::text<>'QUEST'`);
      const after=Number((result.rows[0] as {total:string}).total) +
        incoming.items.reduce((sum,item)=>sum+item.quantity,0) - outgoing.items.reduce((sum,item)=>sum+item.quantity,0);
      if(after>INVENTORY_LIMITS.TEAM) throw httpError("Receiving team inventory is full",409);
    };
    await capacity(offer.initiator_team_id,counter,initiatorSide);
    await capacity(offer.counterparty_team_id,initiatorSide,counter);

    await transferBundle(tx, offer.initiator_team_id, offer.counterparty_team_id, initiatorSide);
    await transferBundle(tx, offer.counterparty_team_id, offer.initiator_team_id, counter);

    const counterLabels = [];
    for (const it of counter.items) {
      counterLabels.push(`${it.quantity}× item`);
    }
    if (counter.denarii > 0) counterLabels.push(`${counter.denarii} Denare`);

    await tx.execute(sql`
      UPDATE trade_offer
      SET status = 'ACCEPTED',
          counterparty_payload = ${JSON.stringify({ ...counter, itemLabels: counterLabels })}::jsonb,
          updated_at = now()
      WHERE id = ${opts.offerId}::uuid
    `);

    await tx.execute(sql`
      INSERT INTO team_trade (idempotency_key, sender_team_id, receiver_team_id, payload)
      VALUES (
        ${randomUUID()}::uuid,
        ${offer.initiator_team_id}::uuid,
        ${offer.counterparty_team_id}::uuid,
        ${JSON.stringify({ initiator: initiatorSide, counterparty: counter })}::jsonb
      )
    `);
  });

  const done = await getOfferById(opts.offerId);
  if (!done) throw httpError("Offer not found", 404);
  return done;
}

export async function rejectTradeOffer(opts: {
  offerId: string;
  teamId: string;
}): Promise<void> {
  const res = await db.execute(sql`
    UPDATE trade_offer
    SET status = 'REJECTED', updated_at = now()
    WHERE id = ${opts.offerId}::uuid
      AND status = 'OPEN'
      AND counterparty_team_id = ${opts.teamId}::uuid
    RETURNING id
  `);
  if (res.rows.length === 0) {
    throw httpError("Offer not found or not rejectable", 404);
  }
}

export async function cancelTradeOffer(opts: {
  offerId: string;
  teamId: string;
}): Promise<void> {
  const res = await db.execute(sql`
    UPDATE trade_offer
    SET status = 'CANCELLED', updated_at = now()
    WHERE id = ${opts.offerId}::uuid
      AND status = 'OPEN'
      AND initiator_team_id = ${opts.teamId}::uuid
    RETURNING id
  `);
  if (res.rows.length === 0) {
    throw httpError("Offer not found or not cancellable", 404);
  }
}

/** Legacy one-way transfer (kept for smoke tests / admin). */
export async function executeTeamTrade(opts: {
  idempotencyKey: string;
  senderTeamId: string;
  receiverTeamId: string;
  items?: TradeItem[];
  currencies?: TradeCurrency[];
}): Promise<{ alreadyProcessed: boolean; success: boolean }> {
  const side: TradeSide = {
    items: opts.items ?? [],
    denarii: opts.currencies?.find((c) => c.currencyType === "DENARII")?.amount ?? 0,
  };
  const existing = await db.execute(sql`
    SELECT id FROM team_trade WHERE idempotency_key = ${opts.idempotencyKey}::uuid
  `);
  if (existing.rows.length > 0) {
    return { alreadyProcessed: true, success: true };
  }
  await db.transaction(async (tx) => {
    const [a, b] = [opts.senderTeamId, opts.receiverTeamId].sort();
    await tx.execute(sql`
      SELECT id FROM team WHERE id IN (${a}::uuid, ${b}::uuid) FOR UPDATE
    `);
    await assertOwnsBundle(tx, opts.senderTeamId, side);
    await transferBundle(tx, opts.senderTeamId, opts.receiverTeamId, side);
    await tx.execute(sql`
      INSERT INTO team_trade (idempotency_key, sender_team_id, receiver_team_id, payload)
      VALUES (
        ${opts.idempotencyKey}::uuid,
        ${opts.senderTeamId}::uuid,
        ${opts.receiverTeamId}::uuid,
        ${JSON.stringify({ items: opts.items, currencies: opts.currencies })}::jsonb
      )
    `);
  });
  return { alreadyProcessed: false, success: true };
}
