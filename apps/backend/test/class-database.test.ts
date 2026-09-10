import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("../src/db/migrations/0014_gdd_class_system.sql",import.meta.url),"utf8");
test("database atomically prevents a duplicate class per team",()=>assert.match(sql,/UNIQUE INDEX[\s\S]*\(team_id, class\)/i));
test("database persists binding and an auditable GM correction",()=>{ assert.match(sql,/class_bound_at/); assert.match(sql,/player_class_audit/); assert.match(sql,/previous_class/); assert.match(sql,/gm_account_id/); assert.match(sql,/reason text NOT NULL/); });
test("database catalog migration contains precisely all new technical ids",()=>{ for(const id of ["guard","cleric","sculptor","condottiere"]) assert.match(sql,new RegExp(`'${id}'`)); });
