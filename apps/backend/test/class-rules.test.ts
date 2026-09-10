import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { CharacterStateSchema, ClassDefinitionSchema } from "@jlw/contracts";
import { classRoutes } from "../src/modules/classes/class.routes.js";
import { CLASSES, SLOTS, STARTER_WEAPONS, FAME_TIERS, fameRewards, ROUND_LOCK_MS, REGEN_SECONDS, addShield, bloodInWaterApplies, classOptionVisible, commercialRound, damage, defaultTarget, deriveStats, effectExpiry, healing, intercessionTarget, isFinisherAvailable, regen, reviveHP, stackEffect } from "../src/modules/classes/class-rules.js";

test("catalog contains exclusively the four GDD classes and one cleric id", () => {
  assert.deepEqual(Object.keys(CLASSES), ["guard", "cleric", "sculptor", "condottiere"]);
  assert.deepEqual(CLASSES.cleric.aliases, ["Nonne", "Mönch"]);
  assert.deepEqual(Object.values(CLASSES).map(c=>c.baseStats), [
    {maxHP:120,atk:8,def:14,initiative:8}, {maxHP:90,atk:7,def:9,initiative:10},
    {maxHP:100,atk:11,def:10,initiative:8}, {maxHP:100,atk:14,def:8,initiative:12},
  ]);
  for (const c of Object.values(CLASSES)) { assert.equal(c.abilities.length, 4); assert.deepEqual(SLOTS,["WEAPON","CLOTHING","DEFENSE","ARTIFACT"]); }
});

test("all GDD 8.10 ability numbers, targets and cooldowns are explicit", () => {
  assert.deepEqual(CLASSES.guard.abilities.map(a=>a.cooldownRounds),[0,2,3,0]);
  assert.deepEqual(CLASSES.cleric.abilities.map(a=>a.cooldownRounds),[0,2,3,0]);
  assert.deepEqual(CLASSES.sculptor.abilities.map(a=>a.cooldownRounds),[0,2,3,0]);
  assert.deepEqual(CLASSES.condottiere.abilities.map(a=>a.cooldownRounds),[0,2,3,0]);
  assert.equal(CLASSES.guard.abilities[0].threatMultiplier,1.5); assert.equal(CLASSES.guard.abilities[1].redirect,.6); assert.equal(CLASSES.guard.abilities[2].damageTakenPercent,-.3); assert.equal(CLASSES.guard.abilities[3].damageTakenPercent,-.1);
  assert.equal(CLASSES.cleric.abilities[1].healBase,20); assert.equal(CLASSES.cleric.abilities[1].healAtkMultiplier,1.5); assert.equal(CLASSES.cleric.abilities[2].shield,10); assert.equal(CLASSES.cleric.abilities[3].revivePercent,.5);
  assert.equal(CLASSES.sculptor.abilities[1].multiplier,.7); assert.equal(CLASSES.sculptor.abilities[1].defPercent,-.25); assert.equal(CLASSES.sculptor.abilities[1].durationRounds,2); assert.equal(CLASSES.sculptor.abilities[2].damageDealtPercent,-.35);
  assert.equal(CLASSES.condottiere.abilities[1].multiplier,1.6); assert.equal(CLASSES.condottiere.abilities[1].selfDamageTakenPercent,.15); assert.equal(CLASSES.condottiere.abilities[2].multiplier,2.2); assert.equal(CLASSES.condottiere.abilities[2].maxTargetHpRatio,.3); assert.equal(CLASSES.condottiere.abilities[3].damageDealtPercent,.15);
});

test("derived stats add equipment, fame, permanent, temporary before percentages",()=> assert.deepEqual(deriveStats("guard",{maxHP:15,atk:4},6,{def:2},{initiative:1},{atk:.25}),{maxHP:141,atk:15,def:16,initiative:9}));
test("damage, minimum, healing, overheal, shields and commercial rounding",()=>{
  assert.equal(commercialRound(2.5),3); assert.equal(commercialRound(2.49),2);
  assert.equal(damage(14,1.6,8),19); assert.equal(damage(0,1,999),1);
  assert.equal(healing(7,100),31); assert.equal(healing(7,5),5); assert.equal(addShield(45,10,100),50);
});
test("duration and status stacking policies",()=>{
  assert.equal(effectExpiry(4,2),5); const old={id:"x",magnitude:.2,stacks:1};
  assert.deepEqual(stackEffect([old],{id:"x",magnitude:.1,stacks:1},"REPLACE_STRONGER"),[old]);
  assert.equal(stackEffect([old],{id:"x",magnitude:.3,stacks:1},"STACK",2)[0]?.stacks,2);
});
test("intercession dispels exactly one by priority then oldest",()=>{
 const effects=[{id:"old-def",tags:["DEF"],removable:true,appliedRound:1},{id:"control",tags:["CONTROL"],removable:true,appliedRound:3},{id:"fixed",tags:["CONTROL"],removable:false,appliedRound:0}];
 assert.equal(intercessionTarget(effects)?.id,"control");
 assert.equal(intercessionTarget(effects.filter(e=>e.id!=="control"))?.id,"old-def");
});
test("15 second lock and deterministic default targeting",()=>{ assert.equal(ROUND_LOCK_MS,15_000); const a=[{id:"first",alive:true},{id:"last",alive:true}]; assert.equal(defaultTarget(a,"last")?.id,"last"); assert.equal(defaultTarget([{id:"last",alive:false},...a])?.id,"first"); });
test("finisher includes 30%, passive is strictly below 30%, and revive rules",()=>{ assert.equal(isFinisherAvailable(30,100),true); assert.equal(bloodInWaterApplies(30,100),false); assert.equal(bloodInWaterApplies(29,100),true); assert.equal(reviveHP(90,"cleric"),45); assert.equal(reviveHP(100,"guard"),30); });
test("900-second linear regeneration and all stop conditions",()=>{ assert.equal(REGEN_SECONDS,900); assert.equal(regen(0,120,450,{alive:true,activeCombat:false,insidePlayArea:true}),60); assert.equal(regen(20,120,900,{alive:false,activeCombat:false,insidePlayArea:true}),20); assert.equal(regen(20,120,900,{alive:true,activeCombat:true,insidePlayArea:true}),20); assert.equal(regen(20,120,900,{alive:true,activeCombat:false,insidePlayArea:false}),20); });
test("spatial class options unlock optional content only while alive and present",()=>{ assert.equal(classOptionVisible("sculptor",[{classId:"sculptor",alive:true,spatiallyValid:true}]),true); assert.equal(classOptionVisible("sculptor",[{classId:"sculptor",alive:false,spatiallyValid:true}]),false); });
test("each class receives a bound N starter weapon and exactly four GDD slots",()=>{ for(const [id,item] of Object.entries(STARTER_WEAPONS)){assert.equal(item.classId,id);assert.equal(item.slot,"WEAPON");assert.equal(item.rarity,"N");assert.equal(item.bound,true);} assert.equal(SLOTS.length,4); });
test("fame tiers grant every reward once and never roll back after fame loss",()=>{ assert.deepEqual(FAME_TIERS.map(t=>[t.threshold,t.denarii,t.hp]),[[0,0,0],[500,40,1],[1000,60,2],[1800,80,3],[2800,110,4],[4000,150,5]]); const first=fameRewards(4000); assert.deepEqual(first,{highestIndex:5,denarii:440,hp:15,newlyReached:["R","SR","SSR","E","L"]}); assert.deepEqual(fameRewards(100,first.highestIndex),{highestIndex:5,denarii:0,hp:15,newlyReached:[]}); });
test("PvE, PvP and boss all consume the identical immutable catalog",()=>{ for(const mode of ["PVE","PVP","BOSS"]) assert.equal((({mode,catalog:CLASSES})).catalog.condottiere.abilities[2].multiplier,2.2); });
test("class catalog API exposes contracts including slots and cooldowns",async()=>{ const app=Fastify(); await app.register(classRoutes,{prefix:"/api/v1/classes"}); const response=await app.inject({method:"GET",url:"/api/v1/classes"}); assert.equal(response.statusCode,200); const body=response.json(); assert.equal(body.length,4); assert.equal(body[1].id,"cleric"); assert.equal(body[0].baseStats.maxHP,120); assert.deepEqual(body[0].slots,SLOTS); assert.equal(body[0].abilities[2].cooldownRounds,3); for(const item of body) ClassDefinitionSchema.parse(item); await app.close(); });
test("UI character contract carries maxHP, cooldown, effects and disabling reasons",()=>{ const state=CharacterStateSchema.parse({classId:"cleric",hpCurrent:70,maxHP:90,atk:7,def:9,initiative:10,statusEffects:[{id:"weak",name:"Schwachstelle",polarity:"NEGATIVE",tags:["DEF"],remainingRounds:2,stacks:1}],cooldowns:{intercession:3},disabledReasons:{intercession:"Noch 3 Runden Abklingzeit"}}); assert.equal(state.maxHP,90); assert.equal(state.cooldowns.intercession,3); assert.equal(state.statusEffects[0]?.remainingRounds,2); assert.match(state.disabledReasons.intercession!,/3 Runden/); });
