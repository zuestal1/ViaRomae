import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { effectiveItemStats, normalizeTradeItems } from "../src/modules/economy/item-rules.js";

test("GDD rarity multipliers scale stats and HP rounds to nearest five",()=>{
  assert.deepEqual(effectiveItemStats({maxHP:15,ATK:4,DEF:1},"R"),{maxHP:20,ATK:5,DEF:1});
  assert.deepEqual(effectiveItemStats({maxHP:15,ATK:4},"L"),{maxHP:40,ATK:11});
});

test("duplicate trade positions are aggregated before ownership validation",()=>{
  assert.deepEqual(normalizeTradeItems([{itemInstanceId:"x",quantity:4},{itemInstanceId:"x",quantity:7}]),
    [{itemInstanceId:"x",quantity:11}]);
});

test("complete migration contains every standard consumable and all four equipment slots",()=>{
  const sql=readFileSync(new URL("../src/db/migrations/0019_gdd_items_complete.sql",import.meta.url),"utf8");
  for(const key of ["panis_viatoris","aqua_vitae","aqua_vitae_magna","unguentum_medicum",
    "wetzstein_legionaer","rauchkugel","geweihter_weihrauch","adlerstandarte","balm_returning",
    "pilgerproviant","notfallreliquie"]) assert.match(sql,new RegExp(`'${key}'`));
  for(const slot of ["WEAPON","CLOTHING","DEFENSE","ARTIFACT"]) assert.match(sql,new RegExp(`'${slot}'`));
  assert.match(sql,/max_stack=10/);
});

test("combat resolver applies all combat consumable mechanics",()=>{
  const service=readFileSync(new URL("../src/modules/combat/combat.service.ts",import.meta.url),"utf8");
  for(const key of ["wetzstein_legionaer","rauchkugel","geweihter_weihrauch","adlerstandarte","notfallreliquie"])
    assert.match(service,new RegExp(key));
});
