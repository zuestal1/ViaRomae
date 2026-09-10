import {
  pgTable,
  uuid,
  varchar,
  integer,
  pgEnum,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";
import { accounts } from "./account.js";

export const playerClassEnum = pgEnum("player_class", [
  "GARDIST",
  "CLERIC",
  "BILDHAUER",
  "CONDOTTIERE",
]);

export const playerStatusEnum = pgEnum("player_status", ["ACTIVE", "DOWNED"]);
export const fameTierEnum = pgEnum("fame_tier", ["N", "R", "SR", "SSR", "E", "L"]);

export const teams = pgTable("team", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 64 }).notNull().unique(),
  inventoryCapacity: integer("inventory_capacity").notNull().default(40),
  // Epic 9: Team-wide HP (sum of all player HP)
  hp: integer("hp").notNull().default(0), // maintained as the sum of derived player HP
  // Epic 9: Team active status
  isActive: integer("is_active").notNull().default(1), // 1 = active, 0 = inactive
  highestFameTierReached: fameTierEnum("highest_fame_tier_reached").notNull().default("N"),
});

export const players = pgTable("player", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  class: playerClassEnum("class").notNull(),
  // Current HP is persisted; maximum HP and combat stats are always derived server-side.
  hpCurrent: integer("hp_current").notNull(),
  fameTierHp: integer("fame_tier_hp").notNull().default(0),
  permanentHp: integer("permanent_hp").notNull().default(0),
  temporaryHp: integer("temporary_hp").notNull().default(0),
  permanentAttack: integer("permanent_attack").notNull().default(0),
  temporaryAttack: integer("temporary_attack").notNull().default(0),
  permanentDefense: integer("permanent_defense").notNull().default(0),
  temporaryDefense: integer("temporary_defense").notNull().default(0),
  permanentInitiative: integer("permanent_initiative").notNull().default(0),
  temporaryInitiative: integer("temporary_initiative").notNull().default(0),
  hpPercent: integer("hp_percent").notNull().default(0),
  attackPercent: integer("attack_percent").notNull().default(0),
  defensePercent: integer("defense_percent").notNull().default(0),
  initiativePercent: integer("initiative_percent").notNull().default(0),
  status: playerStatusEnum("status").notNull().default("ACTIVE"),
  // PostGIS point stored as raw lat/lng for initial Epic 2; migrate to geometry later.
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  // Epic 9: Track when player location was last updated
  lastLocationUpdate: timestamp("last_location_update", { withTimezone: true }),
  // Epic 9: Player display name (denormalized from account)
  playerName: varchar("player_name", { length: 64 }),
});
