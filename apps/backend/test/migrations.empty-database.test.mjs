import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const { Client } = pg;
const migrationsDirectory = new URL("../src/db/migrations/", import.meta.url);
const journalUrl = new URL("meta/_journal.json", migrationsDirectory);
const adminDatabaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

const requiredTables = [
  "item_def",
  "item_instance",
  "quest_run",
  "store_catalog_item",
  "event_state",
  "combat_instance",
  "combatant",
  "combat_action_submission",
  "combat_ability_cooldown",
  "combat_effect",
  "combat_round_order",
  "status_effect_definition",
  "status_effect_instance",
  "ability_cooldown",
  "combat_revive_request",
  "combat_item_action",
  "combat_threat",
];

test(
  "all journaled migrations apply to a completely empty PostGIS database",
  { skip: adminDatabaseUrl ? false : "set MIGRATION_TEST_DATABASE_URL to a PostgreSQL/PostGIS admin database" },
  async () => {
    const journal = JSON.parse(await readFile(journalUrl, "utf8"));
    const databaseName = `viaromae_migrations_${process.pid}_${Date.now()}`;
    const admin = new Client({ connectionString: adminDatabaseUrl });
    const targetUrl = new URL(adminDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;

    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(databaseName)} TEMPLATE template0`);

      const database = new Client({ connectionString: targetUrl.toString() });
      await database.connect();
      try {
        await database.query("CREATE EXTENSION postgis");

        for (const entry of journal.entries) {
          const migrationUrl = new URL(`${entry.tag}.sql`, migrationsDirectory);
          const sql = await readFile(migrationUrl, "utf8");
          await database.query(sql);
        }

        const result = await database.query(
          "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
        );
        const actualTables = new Set(result.rows.map(({ tablename }) => tablename));
        for (const table of requiredTables) {
          assert.ok(actualTables.has(table), `expected migrated table ${table}`);
        }
      } finally {
        await database.end();
      }
    } finally {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(databaseName)}`);
      await admin.end();
    }
  },
);
