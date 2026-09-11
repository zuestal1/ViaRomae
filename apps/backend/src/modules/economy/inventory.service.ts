import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import crypto from "node:crypto";
import { appendLedgerEntry } from "./ledger.service.js";
import { effectiveItemStats, INVENTORY_LIMITS } from "./item-rules.js";

type OwnerType = "PLAYER" | "TEAM";
type StatKey = "maxHP" | "ATK" | "DEF" | "INIT" | "INIT_TIE_BREAKER";
type Stats = Record<StatKey, number>;
const STAT_KEYS: StatKey[] = ["maxHP", "ATK", "DEF", "INIT", "INIT_TIE_BREAKER"];
const CLASS_LABELS: Record<string, string> = {
  guard: "Schweizer Gardist", cleric: "Nonne / Mönch",
  sculptor: "Bildhauer", condottiere: "Condottiere",
};

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export { effectiveItemStats } from "./item-rules.js";

function parseClasses(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string");
  if (typeof raw === "string") {
    try { return parseClasses(JSON.parse(raw)); } catch { return []; }
  }
  return [];
}

function slotFromDef(def: { equip_slot?: string | null; slot?: string | null }): string | null {
  return def.equip_slot ?? def.slot ?? null;
}

export async function getItemCount(ownerType: OwnerType, ownerId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(quantity), 0) AS total
    FROM item_instance
    WHERE owner_type = ${ownerType}::owner_type AND owner_id = ${ownerId}::uuid
      AND (${ownerType}::text <> 'PLAYER' OR is_equipped = false)
      AND (${ownerType}::text <> 'TEAM' OR category::text <> 'QUEST')
  `);
  return Number((res.rows as { total: string }[])[0]?.total ?? 0);
}

export async function moveInventoryItem(accountId: string, opts: {
  itemInstanceId: string; quantity: number; direction: "TAKE" | "DEPOSIT"; equip?: boolean;
}) {
  const movedId = await db.transaction(async (tx) => {
    const playerResult = await tx.execute(sql`SELECT id,team_id,status,class FROM player
      WHERE account_id=${accountId}::uuid FOR UPDATE`);
    const player = playerResult.rows[0] as { id:string; team_id:string; status:string; class:string } | undefined;
    if (!player) throw httpError("Player not found", 404);
    const sourceType: OwnerType = opts.direction === "TAKE" ? "TEAM" : "PLAYER";
    const sourceOwner = opts.direction === "TAKE" ? player.team_id : player.id;
    const targetType: OwnerType = opts.direction === "TAKE" ? "PLAYER" : "TEAM";
    const targetOwner = opts.direction === "TAKE" ? player.id : player.team_id;
    const found = await tx.execute(sql`SELECT i.*,d.stackable,d.max_stack,d.allowed_classes,d.equip_slot
      FROM item_instance i JOIN item_def d ON d.key=i.definition_id
      WHERE i.id=${opts.itemInstanceId}::uuid FOR UPDATE`);
    const item = found.rows[0] as Record<string, unknown> | undefined;
    if (!item || item.owner_type !== sourceType || item.owner_id !== sourceOwner) throw httpError("Item not found in source inventory", 404);
    const reserved=await tx.execute(sql`SELECT 1 FROM combat_item_action WHERE item_instance_id=${opts.itemInstanceId}::uuid AND resolved_at IS NULL`);
    if(reserved.rows.length) throw httpError("Item is reserved for the current combat round",409);
    if (opts.quantity < 1 || opts.quantity > Number(item.quantity)) throw httpError("Invalid quantity", 400);
    if (item.is_equipped) throw httpError("Ausgerüstete Items müssen zuerst abgelegt werden", 409);
    if (item.is_bound && opts.direction === "DEPOSIT") throw httpError("Gebundene Items bleiben persönlich", 409);
    if (item.category === "QUEST" && opts.direction !== "DEPOSIT") throw httpError("Questitems bleiben im Teaminventar", 409);
    if (opts.equip && (opts.direction !== "TAKE" || item.category !== "EQUIPMENT")) throw httpError("Item cannot be equipped", 400);
    const allowed = parseClasses(item.allowed_classes);
    if (opts.equip && allowed.length && !allowed.includes(player.class)) throw httpError("Item is restricted to another class", 403);

    const count = await tx.execute(sql`SELECT COALESCE(SUM(quantity),0) total FROM item_instance
      WHERE owner_type=${targetType}::owner_type AND owner_id=${targetOwner}::uuid
        AND (${targetType}::text <> 'PLAYER' OR is_equipped=false)
        AND (${targetType}::text <> 'TEAM' OR category::text <> 'QUEST')`);
    const countsCapacity = item.category !== "QUEST" && !opts.equip;
    if (countsCapacity && Number((count.rows[0] as {total:string}).total) + opts.quantity > INVENTORY_LIMITS[targetType]) {
      throw httpError("Inventory limit exceeded", 409);
    }
    if (opts.equip) await tx.execute(sql`UPDATE item_instance SET is_equipped=false
      WHERE owner_type='PLAYER' AND owner_id=${player.id}::uuid AND slot=${item.equip_slot as string}::item_slot`);
    if (Number(item.quantity) === opts.quantity) {
      await tx.execute(sql`UPDATE item_instance SET owner_type=${targetType}::owner_type,
        owner_id=${targetOwner}::uuid,is_equipped=${Boolean(opts.equip)} WHERE id=${opts.itemInstanceId}::uuid`);
      return opts.itemInstanceId;
    }
    await tx.execute(sql`UPDATE item_instance SET quantity=quantity-${opts.quantity} WHERE id=${opts.itemInstanceId}::uuid`);
    const inserted = await tx.execute(sql`INSERT INTO item_instance
      (definition_id,owner_type,owner_id,quantity,category,slot,is_equipped,is_bound,is_quest_locked)
      VALUES (${String(item.definition_id)},${targetType}::owner_type,${targetOwner}::uuid,${opts.quantity},
        ${String(item.category)}::item_category,${item.slot as string | null}::item_slot,${Boolean(opts.equip)},
        ${Boolean(item.is_bound)},${Boolean(item.is_quest_locked)}) RETURNING id`);
    return String((inserted.rows[0] as {id:string}).id);
  });
  return opts.equip ? { moved: movedId, equipped: movedId } : { moved: movedId };
}

export async function assignLoot(opts: {
  idempotencyKey: string;
  ownerType: OwnerType;
  ownerId: string;
  items?: { defKey: string; quantity: number }[];
  currencies?: {
    currencyType: "DENARII" | "FAME";
    amount: number;
    playerId?: string | null;
  }[];
  personalLimit?: number;
  teamLimit?: number;
}) {
  const {
    idempotencyKey,
    ownerType,
    ownerId,
    items = [],
    currencies = [],
    personalLimit = INVENTORY_LIMITS.PLAYER,
    teamLimit = INVENTORY_LIMITS.TEAM,
  } = opts;

  const existing = await db.execute(sql`
    SELECT * FROM inventory_action WHERE idempotency_key = ${idempotencyKey}::uuid
  `);
  if (existing.rows.length > 0) {
    return { alreadyProcessed: true, result: existing.rows[0] };
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id FROM item_instance
      WHERE owner_type = ${ownerType}::owner_type AND owner_id = ${ownerId}::uuid
      FOR UPDATE
    `);

    const countRes = await tx.execute(sql`
      SELECT COALESCE(SUM(quantity), 0) AS total
      FROM item_instance
      WHERE owner_type = ${ownerType}::owner_type AND owner_id = ${ownerId}::uuid
        AND (${ownerType}::text <> 'PLAYER' OR is_equipped=false)
        AND (${ownerType}::text <> 'TEAM' OR category::text<>'QUEST')
    `);
    const currentTotal = Number((countRes.rows as { total: string }[])[0]?.total ?? 0);
    let incomingTotal=0;
    for(const item of items){const category=await tx.execute(sql`SELECT category FROM item_def WHERE key=${item.defKey}`);
      if(ownerType!=="TEAM" || (category.rows[0] as {category?:string}|undefined)?.category!=="QUEST") incomingTotal+=Math.max(0,item.quantity|0);}
    const limit = ownerType === "PLAYER" ? personalLimit : teamLimit;
    if (currentTotal + incomingTotal > limit) {
      throw httpError(
        `Inventory limit exceeded: ${currentTotal + incomingTotal} > ${limit}`,
        409,
      );
    }

    for (const it of items) {
      const defRes = await tx.execute(sql`SELECT * FROM item_def WHERE key = ${it.defKey}`);
      const def = (defRes.rows as {
        stackable: boolean;
        max_stack:number;
        equip_slot: string | null; category: string;
      }[])[0];
      if (!def) throw httpError(`Item definition not found: ${it.defKey}`, 404);

      const slot = slotFromDef(def);
      const category = def.category ?? "EQUIPMENT";

      if (def.stackable) {
        let remaining=it.quantity;
        while(remaining>0){
          const stack=await tx.execute(sql`SELECT id,quantity FROM item_instance WHERE owner_type=${ownerType}::owner_type
            AND owner_id=${ownerId}::uuid AND definition_id=${it.defKey} AND quantity<${def.max_stack} ORDER BY id LIMIT 1 FOR UPDATE`);
          const existing=stack.rows[0] as {id:string;quantity:number}|undefined;
          const amount=Math.min(remaining,def.max_stack-(existing?.quantity??0));
          if(existing) await tx.execute(sql`UPDATE item_instance SET quantity=quantity+${amount} WHERE id=${existing.id}::uuid`);
          else {
          await tx.execute(sql`
            INSERT INTO item_instance
              (id, definition_id, owner_type, owner_id, quantity, category, slot, is_equipped, is_bound, is_quest_locked)
            VALUES (
              gen_random_uuid(), ${it.defKey}, ${ownerType}::owner_type, ${ownerId}::uuid,
              ${amount}, ${category}::item_category, ${slot}::item_slot, false,
              ${it.defKey.startsWith("qi_")}, ${category === "QUEST" || it.defKey.startsWith("qi_")}
            )
          `);}
          remaining-=amount;
        }
      } else {
        for (let i = 0; i < it.quantity; i++) {
          await tx.execute(sql`
            INSERT INTO item_instance
              (id, definition_id, owner_type, owner_id, quantity, category, slot, is_equipped, is_bound, is_quest_locked)
            VALUES (
              gen_random_uuid(), ${it.defKey}, ${ownerType}::owner_type, ${ownerId}::uuid,
              1, ${category}::item_category, ${slot}::item_slot, false,
              ${it.defKey.startsWith("qi_")}, ${category === "QUEST" || it.defKey.startsWith("qi_")}
            )
          `);
        }
      }
    }

    let teamIdForPlayer: string | null = null;
    if (ownerType === "PLAYER") {
      const tp = await tx.execute(sql`
        SELECT team_id FROM player WHERE id = ${ownerId}::uuid
      `);
      teamIdForPlayer = (tp.rows as { team_id: string }[])[0]?.team_id ?? null;
      if (!teamIdForPlayer) {
        throw httpError("Player not found or has no team", 404);
      }
    }

    for (const cur of currencies) {
      await appendLedgerEntry({
        idempotencyKey: crypto.randomUUID(),
        teamId: ownerType === "TEAM" ? ownerId : (teamIdForPlayer as string),
        playerId: cur.playerId ?? (ownerType === "PLAYER" ? ownerId : null),
        currencyType: cur.currencyType,
        amount: cur.amount,
        source: "QUEST",
      });
    }

    await tx.execute(sql`
      INSERT INTO inventory_action (idempotency_key, owner_type, owner_id, payload)
      VALUES (
        ${idempotencyKey}::uuid,
        ${ownerType}::owner_type,
        ${ownerId}::uuid,
        ${JSON.stringify({ items, currencies })}::jsonb
      )
    `);

    return {
      alreadyProcessed: false,
      result: { itemsAssigned: items.length, currenciesAssigned: currencies.length },
    };
  });
}

export async function listInventory(ownerType: OwnerType, ownerId: string): Promise<Record<string, unknown>[]> {
  const res = await db.execute(sql`
    SELECT i.*, d.name, d.stats, d.stackable, d.rarity, d.allowed_classes,
           d.category AS definition_category, d.equip_slot, p.class AS player_class,
           p.status AS player_status
    FROM item_instance i
    LEFT JOIN item_def d ON d.key = i.definition_id
    LEFT JOIN player p ON i.owner_type = 'PLAYER' AND p.id = i.owner_id
    WHERE i.owner_type = ${ownerType}::owner_type AND i.owner_id = ${ownerId}::uuid
    ORDER BY d.name ASC
  `);
  return (res.rows as Record<string, unknown>[]).map((row) => {
    const allowedClasses = parseClasses(row.allowed_classes);
    const playerClass = String(row.player_class ?? "");
    const category = String(row.definition_category ?? row.category ?? "EQUIPMENT");
    let unusableReason: string | null = null;
    if (category !== "EQUIPMENT" || !row.equip_slot) unusableReason = "Nicht ausrüstbar";
    else if (String(row.owner_type) !== "PLAYER") unusableReason = "Nur im persönlichen Inventar ausrüstbar";
    else if (String(row.player_status) !== "ACTIVE") unusableReason = "Im aktuellen Zustand nicht ausrüstbar";
    else if (allowedClasses.length && !allowedClasses.includes(playerClass)) {
      unusableReason = `Nur ${allowedClasses.map((c) => CLASS_LABELS[c] ?? c).join(" oder ")}`;
    }
    return { ...row, allowed_classes: allowedClasses, effective_stats: effectiveItemStats(row.stats, String(row.rarity ?? "N")), can_equip: !unusableReason, unusable_reason: unusableReason };
  });
}

export async function equipItem(accountId: string, itemInstanceId: string) {
  return db.transaction(async (tx) => {
    const rowRes = await tx.execute(sql`
      SELECT i.*, d.equip_slot, d.category, d.allowed_classes, d.stats, d.rarity,
             p.id AS player_id, p.class AS player_class, p.status AS player_status
      FROM item_instance i JOIN item_def d ON d.key=i.definition_id
      JOIN player p ON p.account_id=${accountId}::uuid
      WHERE i.id=${itemInstanceId}::uuid FOR UPDATE
    `);
    const row = rowRes.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw httpError("Item not found", 404);
    const reserved=await tx.execute(sql`SELECT 1 FROM combat_item_action WHERE item_instance_id=${itemInstanceId}::uuid AND resolved_at IS NULL`);
    if(reserved.rows.length) throw httpError("Item is reserved for the current combat round",409);
    const playerId = String(row.player_id);
    if (row.owner_type !== "PLAYER" || row.owner_id !== playerId) throw httpError("Item not owned by player", 403);
    if (row.category !== "EQUIPMENT" || !row.equip_slot || row.slot !== row.equip_slot) throw httpError("Item slot is invalid", 400);
    if (row.player_status !== "ACTIVE" || Number(row.quantity) < 1 || row.is_equipped) throw httpError("Item cannot be equipped in its current state", 409);
    const allowed = parseClasses(row.allowed_classes);
    if (allowed.length && !allowed.includes(String(row.player_class))) {
      throw httpError(`Nur ${allowed.map((c) => CLASS_LABELS[c] ?? c).join(" oder ")}`, 403);
    }
    const oldRes = await tx.execute(sql`SELECT d.stats, d.rarity FROM item_instance i JOIN item_def d ON d.key=i.definition_id WHERE i.owner_id=${playerId}::uuid AND i.slot=${row.equip_slot as string}::item_slot AND i.is_equipped`);
    const oldItem = oldRes.rows[0] as Record<string, unknown> | undefined;
    const oldStats = effectiveItemStats(oldItem?.stats, String(oldItem?.rarity ?? "N"));
    const newStats = effectiveItemStats(row.stats, String(row.rarity));
    await tx.execute(sql`
      UPDATE item_instance SET is_equipped = false
      WHERE owner_type = 'PLAYER'::owner_type
        AND owner_id = ${playerId}::uuid
        AND is_equipped = true
        AND definition_id IN (SELECT key FROM item_def WHERE equip_slot = ${row.equip_slot}::item_slot)
    `);
    await tx.execute(sql`
      UPDATE item_instance SET is_equipped = true WHERE id = ${itemInstanceId}::uuid
    `);
    const difference = Object.fromEntries(STAT_KEYS.map((key) => [key, (newStats[key]??0) - (oldStats[key]??0)]));
    return { equipped: itemInstanceId, slot: row.equip_slot, comparison: { old: oldStats, new: newStats, difference } };
  });
}

export async function unequipItem(accountId: string, itemInstanceId: string) {
  const playerRow = await db.execute(sql`
    SELECT p.id AS player_id FROM player p WHERE p.account_id = ${accountId}::uuid
  `);
  const player = (playerRow.rows as { player_id: string }[])[0];
  if (!player) throw httpError("Player not found", 404);

  const rowRes = await db.execute(sql`
    SELECT * FROM item_instance WHERE id = ${itemInstanceId}::uuid
  `);
  const row = (rowRes.rows as { owner_type: string; owner_id: string }[])[0];
  if (!row) throw httpError("Item not found", 404);
  if (row.owner_type !== "PLAYER" || row.owner_id !== player.player_id) {
    throw httpError("Item not owned by player", 403);
  }
  if (await getItemCount("PLAYER", player.player_id) >= INVENTORY_LIMITS.PLAYER) {
    throw httpError("Personal inventory is full", 409);
  }

  await db.execute(sql`
    UPDATE item_instance SET is_equipped = false WHERE id = ${itemInstanceId}::uuid
  `);
  return { unequipped: itemInstanceId };
}

export async function computeEquippedStats(ownerType: OwnerType, ownerId: string) {
  const res = await db.execute(sql`
    SELECT d.stats, d.rarity
    FROM item_instance i
    JOIN item_def d ON d.key = i.definition_id
    WHERE i.owner_type = ${ownerType}::owner_type
      AND i.owner_id = ${ownerId}::uuid
      AND i.is_equipped = true
  `);
  const totals: Stats = { maxHP: 0, ATK: 0, DEF: 0, INIT: 0, INIT_TIE_BREAKER: 0 };
  for (const r of res.rows as { stats: unknown; rarity?: string }[]) {
    for (const [k, v] of Object.entries(effectiveItemStats(r.stats, r.rarity ?? "N"))) {
      totals[k as StatKey] = (totals[k as StatKey] ?? 0) + v;
    }
  }
  return totals as Record<string, number>;
}

const STARTER_WEAPON_BY_CLASS: Record<string, string> = {
  guard: "starter_halberd", cleric: "starter_pilgrim_staff",
  sculptor: "starter_chisel_hammer", condottiere: "starter_side_sword",
};

/** Called by the class-confirmation flow. The inventory precondition makes retries safe. */
export async function grantInitialClassWeapon(playerId: string): Promise<{ itemInstanceId: string; definitionId: string }> {
  return db.transaction(async (tx) => {
    const playerResult = await tx.execute(sql`SELECT id, class FROM player WHERE id=${playerId}::uuid FOR UPDATE`);
    const player = playerResult.rows[0] as { id: string; class: string } | undefined;
    if (!player) throw httpError("Player not found", 404);
    const existing = await tx.execute(sql`SELECT id FROM item_instance WHERE owner_type='PLAYER' AND owner_id=${playerId}::uuid FOR UPDATE`);
    if (existing.rows.length) throw httpError("Initial equipment has already been assigned", 409);
    const definitionId = STARTER_WEAPON_BY_CLASS[player.class];
    if (!definitionId) throw httpError("No starter weapon for class", 400);
    const inserted = await tx.execute(sql`
      INSERT INTO item_instance (id, definition_id, owner_type, owner_id, quantity, category, slot, is_equipped, is_bound)
      VALUES (gen_random_uuid(), ${definitionId}, 'PLAYER', ${playerId}::uuid, 1, 'EQUIPMENT', 'WEAPON', true, true)
      RETURNING id
    `);
    return { itemInstanceId: String((inserted.rows[0] as { id: string }).id), definitionId };
  });
}
