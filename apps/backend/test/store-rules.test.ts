import assert from "node:assert/strict";
import test from "node:test";
import { calculateStoreSellPrice, storeInteractionBlockReason } from "../src/modules/economy/store.service.js";

const valid = {
  player_id:"p", team_id:"t", store_id:"s", external_id:"PT-STORE-01", store_name:"Bottega",
  distance_m:"20", interaction_radius_m:15, last_location_update:new Date(),
  last_location_accuracy:5, valid_location_streak:2,
};

test("GDD sell price is 15 percent rounded to nearest five",()=>{
  assert.equal(calculateStoreSellPrice(15),0);
  assert.equal(calculateStoreSellPrice(30),5);
  assert.equal(calculateStoreSellPrice(45),5);
  assert.equal(calculateStoreSellPrice(120),20);
});

test("store distance credits no more than ten metres of GPS accuracy",()=>{
  assert.equal(storeInteractionBlockReason({...valid,distance_m:"25",last_location_accuracy:50}),null);
  assert.match(storeInteractionBlockReason({...valid,distance_m:"25.1",last_location_accuracy:50})??"",/16 m/);
});

test("store requires two fresh, accurate measurements",()=>{
  assert.match(storeInteractionBlockReason({...valid,valid_location_streak:1})??"",/zweite/);
  assert.match(storeInteractionBlockReason({...valid,last_location_accuracy:51})??"",/50 m/);
  assert.match(storeInteractionBlockReason({...valid,last_location_update:new Date(Date.now()-16_000)})??"",/15 Sekunden/);
});
