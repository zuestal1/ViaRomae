import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const storeContent = JSON.parse(await read("content/store-content-v0.17.json"));
const geoJson = JSON.parse(await read("../../docs/Via_Romae_GameObjects_v0.8.geojson"));
const itemMigration = await read("src/db/migrations/0019_gdd_items_complete.sql");

test("all five approved Rome store locations have coordinates and production radii", () => {
  assert.equal(storeContent.stores.length, 5);
  for (const store of storeContent.stores) {
    const feature = geoJson.features.find((candidate) => candidate.id === store.externalId);
    assert.ok(feature, store.externalId);
    assert.equal(feature.properties.content_status, "APPROVED", store.externalId);
    assert.equal(feature.properties.publishable, true, store.externalId);
    assert.ok(feature.properties.support_roles.includes("STORE_LOCATION_CANDIDATE"), store.externalId);
    assert.equal(feature.geometry.type, "Point", store.externalId);
    assert.equal(feature.geometry.coordinates.length, 2, store.externalId);
    assert.deepEqual(feature.properties.geofence, {
      interaction_radius_m: 15,
      exit_hysteresis_radius_m: 25,
      discovery_radius_m: 55,
    }, store.externalId);
  }
});

test("buying and selling is statically covered for every production store", async () => {
  const routes = await read("src/modules/economy/store.routes.ts");
  const service = await read("src/modules/economy/store.service.ts");
  assert.match(routes, /\/:storeId\/buy/);
  assert.match(routes, /\/:storeId\/sell/);
  assert.match(service, /purchaseStoreItem/);
  assert.match(service, /sellStoreItem/);

  for (const store of storeContent.stores) {
    assert.ok(store.catalog.length > 0, `${store.externalId}: buy catalogue`);
    assert.ok(
      store.catalog.some(({ definitionId }) =>
        new RegExp(`'${definitionId}'[^\\n]+EQUIPMENT`).test(itemMigration),
      ),
      `${store.externalId}: an equipment item can be bought and sold`,
    );
    for (const { definitionId, price } of store.catalog) {
      assert.match(itemMigration, new RegExp(`'${definitionId}'`), definitionId);
      assert.ok(Number.isInteger(price) && price > 0, definitionId);
    }
  }
});

test("seed exposes stores to geo discovery and upserts catalogues idempotently", async () => {
  const seed = await read("scripts/seed.ts");
  const geo = await read("src/modules/geo/geo.service.ts");
  assert.match(seed, /isStore \? "STORE"/);
  assert.match(seed, /ON CONFLICT \(store_id, definition_id\)/);
  assert.match(seed, /DO UPDATE SET price = EXCLUDED\.price/);
  assert.match(geo, /wo\.publishable = true/);
  assert.match(geo, /wo\.type/);
});
