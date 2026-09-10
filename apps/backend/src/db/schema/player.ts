import {
  pgTable,
  uuid,
  varchar,
  integer,
  pgEnum,
  doublePrecision,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./account.js";

export const playerClassEnum = pgEnum("player_class", [
  "swiss_guard",
  "cleric",
  "sculptor",
  "condottiere",
]);

export const playerStatusEnum = pgEnum("player_status", ["ACTIVE", "DOWNED"]);

export const teams = pgTable("team", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 64 }).notNull().unique(),
  inventoryCapacity: integer("inventory_capacity").notNull().default(40),
  // Epic 9: Team-wide HP (sum of all player HP)
  hp: integer("hp").notNull().default(400), // 4 players × 100 HP
  // Epic 9: Team active status
  isActive: integer("is_active").notNull().default(1), // 1 = active, 0 = inactive
});

export const players = pgTable("player", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  // A choice may be tentative. Once confirmed it is immutable for players.
  class: playerClassEnum("class"),
  classConfirmed: boolean("class_confirmed").notNull().default(false),
  classSelectedAt: timestamp("class_selected_at", { withTimezone: true }),
  classConfirmedAt: timestamp("class_confirmed_at", { withTimezone: true }),
  classAssignedBy: uuid("class_assigned_by").references(() => accounts.id),
  preflightCompletedAt: timestamp("preflight_completed_at", { withTimezone: true }),
  hpCurrent: integer("hp_current").notNull().default(100),
  status: playerStatusEnum("status").notNull().default("ACTIVE"),
  // PostGIS point stored as raw lat/lng for initial Epic 2; migrate to geometry later.
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  // Epic 9: Track when player location was last updated
  lastLocationUpdate: timestamp("last_location_update", { withTimezone: true }),
  // Epic 9: Player display name (denormalized from account)
  playerName: varchar("player_name", { length: 64 }),
}, (table) => [
  uniqueIndex("player_team_confirmed_class_unique")
    .on(table.teamId, table.class)
    .where(sql`${table.classConfirmed} = true AND ${table.class} IS NOT NULL`),
]);
