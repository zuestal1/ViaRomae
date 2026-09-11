import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";

function httpError(message:string,statusCode:number){return Object.assign(new Error(message),{statusCode});}

const COMBAT_ITEMS=new Set(["aqua_vitae","aqua_vitae_magna","unguentum_medicum","wetzstein_legionaer",
  "rauchkugel","geweihter_weihrauch","adlerstandarte"]);

export async function useConsumable(accountId:string,input:{itemInstanceId:string;targetId?:string;requestId:string}) {
  return db.transaction(async tx => {
    const combatReplay=await tx.execute(sql`SELECT definition_id FROM combat_item_action WHERE request_id=${input.requestId}::uuid`);
    if(combatReplay.rows[0]) return {alreadyProcessed:true,queued:true,definitionId:(combatReplay.rows[0] as {definition_id:string}).definition_id};
    const replay=await tx.execute(sql`SELECT payload FROM inventory_action WHERE idempotency_key=${input.requestId}::uuid`);
    if(replay.rows[0]) return {alreadyProcessed:true,...(replay.rows[0] as {payload:Record<string,unknown>}).payload};
    const playerResult=await tx.execute(sql`SELECT id,team_id,class,status FROM player WHERE account_id=${accountId}::uuid FOR UPDATE`);
    const player=playerResult.rows[0] as {id:string;team_id:string;class:string;status:string}|undefined;
    if(!player) throw httpError("Player not found",404);
    const found=await tx.execute(sql`SELECT i.*,d.key,d.stats FROM item_instance i JOIN item_def d ON d.key=i.definition_id
      WHERE i.id=${input.itemInstanceId}::uuid AND i.owner_type='PLAYER' AND i.owner_id=${player.id}::uuid FOR UPDATE`);
    const item=found.rows[0] as {id:string;key:string;quantity:number;category:string}|undefined;
    if(!item || item.category!=="CONSUMABLE" || item.quantity<1) throw httpError("Consumable unavailable",409);
    const active=await tx.execute(sql`SELECT ci.id,ci.round_number,c.id combatant_id,c.team_id FROM combat_instance ci
      JOIN combatant c ON c.combat_instance_id=ci.id WHERE c.entity_id=${player.id}::uuid AND c.entity_type='PLAYER'
      AND ci.state IN ('AWAITING_ACTIONS','LOCKED','RESOLVING') ORDER BY ci.started_at DESC LIMIT 1`);
    const combat=active.rows[0] as {id:string;round_number:number;combatant_id:string;team_id:string}|undefined;
    if(combat) {
      if(!COMBAT_ITEMS.has(item.key)) throw httpError("Dieses Item ist im Kampf nicht direkt verwendbar",409);
      const targetId=input.targetId??combat.combatant_id;
      const target=await tx.execute(sql`SELECT id FROM combatant WHERE id=${targetId}::uuid AND combat_instance_id=${combat.id}::uuid
        AND team_id=${combat.team_id}::uuid AND hp_current>0`);
      if(!target.rows.length) throw httpError("Invalid consumable target",409);
      const state=await tx.execute(sql`SELECT state,action_deadline FROM combat_instance WHERE id=${combat.id}::uuid FOR UPDATE`);
      const current=state.rows[0] as {state:string;action_deadline:Date};
      if(current.state!=="AWAITING_ACTIONS" || new Date(current.action_deadline).getTime()<=Date.now()) throw httpError("Combat action is locked",409);
      const action=await tx.execute(sql`INSERT INTO combat_action(id,combat_instance_id,round_number,actor_id,action_type,is_locked,origin,idempotency_key)
        VALUES(gen_random_uuid(),${combat.id}::uuid,${combat.round_number},${combat.combatant_id}::uuid,'DEFEND',false,'PLAYER_SUBMITTED',${randomUUID()}::uuid)
        ON CONFLICT(combat_instance_id,round_number,actor_id) DO UPDATE SET action_type='DEFEND',target_id=NULL,ability_id=NULL,
          idempotency_key=EXCLUDED.idempotency_key WHERE combat_action.is_locked=false RETURNING id`);
      if(!action.rows[0]) throw httpError("Combat action is locked",409);
      const actionId=String((action.rows[0] as {id:string}).id);
      await tx.execute(sql`DELETE FROM combat_item_action WHERE combat_action_id=${actionId}::uuid`);
      await tx.execute(sql`INSERT INTO combat_item_action(request_id,combat_action_id,item_instance_id,definition_id,target_combatant_id)
        VALUES(${input.requestId}::uuid,${actionId}::uuid,${item.id}::uuid,${item.key},${targetId}::uuid)`);
      return {alreadyProcessed:false,queued:true,combatId:combat.id,round:combat.round_number};
    }
    const healing:Record<string,number>={panis_viatoris:20,aqua_vitae:35,aqua_vitae_magna:70,unguentum_medicum:10};
    if(item.key in healing) await tx.execute(sql`UPDATE player SET hp_current=GREATEST(hp_current,LEAST(hp_current+${healing[item.key]},
      CASE class WHEN 'guard' THEN 120 WHEN 'cleric' THEN 90 ELSE 100 END + fame_tier_hp+permanent_hp)) WHERE id=${player.id}::uuid AND status='ACTIVE'`);
    else if(item.key==="pilgerproviant") await tx.execute(sql`UPDATE player SET hp_current=GREATEST(hp_current,LEAST(hp_current+25,
      CASE class WHEN 'guard' THEN 120 WHEN 'cleric' THEN 90 ELSE 100 END + fame_tier_hp+permanent_hp)) WHERE team_id=${player.team_id}::uuid AND status='ACTIVE'`);
    else if(item.key==="balm_returning") {
      const target=input.targetId ?? player.id;
      const percent=player.class==="cleric"?50:30;
      const revived=await tx.execute(sql`UPDATE player SET status='ACTIVE',hp_current=ROUND((CASE class WHEN 'guard' THEN 120 WHEN 'cleric' THEN 90 ELSE 100 END + fame_tier_hp+permanent_hp)*${percent}/100.0)
        WHERE id=${target}::uuid AND team_id=${player.team_id}::uuid AND status='DOWNED' RETURNING id`);
      if(!revived.rows.length) throw httpError("No downed team member selected",409);
    } else throw httpError("Dieses Item kann nur im Kampf verwendet werden",409);
    await tx.execute(sql`UPDATE item_instance SET quantity=quantity-1 WHERE id=${item.id}::uuid`);
    await tx.execute(sql`DELETE FROM item_instance WHERE id=${item.id}::uuid AND quantity=0`);
    const payload={used:item.id,definitionId:item.key};
    await tx.execute(sql`INSERT INTO inventory_action(idempotency_key,owner_type,owner_id,payload)
      VALUES(${input.requestId}::uuid,'PLAYER',${player.id}::uuid,${JSON.stringify(payload)}::jsonb)`);
    return {alreadyProcessed:false,...payload};
  });
}

export async function resolveCombatConsumable(actionId:string,combatId:string,round:number) {
  return db.transaction(async tx=>{
    const use=await tx.execute(sql`SELECT cia.*,i.quantity FROM combat_item_action cia JOIN item_instance i ON i.id=cia.item_instance_id
      WHERE cia.combat_action_id=${actionId}::uuid AND cia.resolved_at IS NULL FOR UPDATE`);
    const row=use.rows[0] as {id:string;item_instance_id:string;definition_id:string;target_combatant_id:string;quantity:number}|undefined;
    if(!row || row.quantity<1) return null;
    const heals:Record<string,number>={aqua_vitae:35,aqua_vitae_magna:70,unguentum_medicum:10};
    if(row.definition_id in heals) {await tx.execute(sql`UPDATE combatant SET hp_current=GREATEST(hp_current,LEAST(hp_current+${heals[row.definition_id]},
      COALESCE((SELECT CASE p.class WHEN 'guard' THEN 120 WHEN 'cleric' THEN 90 ELSE 100 END+p.fame_tier_hp+p.permanent_hp FROM player p WHERE p.id=combatant.entity_id),hp_current+${heals[row.definition_id]}))
      WHERE id=${row.target_combatant_id}::uuid AND hp_current>0`);
      await tx.execute(sql`UPDATE player p SET hp_current=c.hp_current FROM combatant c WHERE c.id=${row.target_combatant_id}::uuid AND p.id=c.entity_id`);}
    if(row.definition_id==="unguentum_medicum") await tx.execute(sql`DELETE FROM combat_effect WHERE id=(SELECT id FROM combat_effect
      WHERE combat_instance_id=${combatId}::uuid AND target_combatant_id=${row.target_combatant_id}::uuid
        AND ability_id IN ('sculptor.schwachstelle','sculptor.marmorstaub','condottiere.duell') ORDER BY id LIMIT 1)`);
    const duration=row.definition_id==="adlerstandarte"?round+2:
      row.definition_id==="geweihter_weihrauch"?round+1:null;
    if(["wetzstein_legionaer","rauchkugel","geweihter_weihrauch","adlerstandarte"].includes(row.definition_id))
      await tx.execute(sql`INSERT INTO combat_effect(combat_instance_id,source_combatant_id,target_combatant_id,ability_id,expires_at_round,state)
        SELECT ${combatId}::uuid,source.id,target.id,${`item.${row.definition_id}`},${duration},'{}'::jsonb
        FROM combat_action a JOIN combatant source ON source.id=a.actor_id
        JOIN combatant target ON target.combat_instance_id=source.combat_instance_id
          AND (CASE WHEN ${row.definition_id} IN ('geweihter_weihrauch','adlerstandarte')
            THEN target.team_id=source.team_id ELSE target.id=${row.target_combatant_id}::uuid END)
        WHERE a.id=${actionId}::uuid`);
    await tx.execute(sql`UPDATE item_instance SET quantity=quantity-1 WHERE id=${row.item_instance_id}::uuid`);
    await tx.execute(sql`DELETE FROM item_instance WHERE id=${row.item_instance_id}::uuid AND quantity=0`);
    await tx.execute(sql`UPDATE combat_item_action SET resolved_at=now() WHERE id=${row.id}::uuid`);
    return row.definition_id;
  });
}
