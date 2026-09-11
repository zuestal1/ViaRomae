import {
  pgTable,
  uuid,
  pgEnum,
  integer,
  timestamp,
  boolean,
  varchar,
} from "drizzle-orm/pg-core";
import { teams, players } from "./player.js";

export const currencyTypeEnum = pgEnum("currency_type", ["FAME", "DENARII"]);
export const ledgerSourceEnum = pgEnum("ledger_source", [
  "QUEST",
  "COMBAT",
  "TRADE",
  "STORE",
  "ADMIN",
]);
export const itemSlotEnum = pgEnum("item_slot", [
  "WEAPON",
  "CLOTHING",
  "DEFENSE",
  "ARTIFACT",
]);
export const itemCategoryEnum = pgEnum("item_category", ["EQUIPMENT", "CONSUMABLE"]);
export const itemRarityEnum = pgEnum("item_rarity", ["N", "R", "SR", "SSR", "E", "L"]);

export const ownerTypeEnum = pgEnum("owner_type", ["PLAYER", "TEAM"]);

/** Append-only ledger – never update, only insert. */
export const ledgerEntries = pgTable("ledger_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id),
  playerId: uuid("player_id").references(() => players.id),
  currencyType: currencyTypeEnum("currency_type").notNull(),
  amount: integer("amount").notNull(),
  source: ledgerSourceEnum("source").notNull(),
  /** Prevents duplicate bookings */
  idempotencyKey: uuid("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const itemInstances = pgTable("item_instance", {
  id: uuid("id").primaryKey().defaultRandom(),
  definitionId: varchar("definition_id", { length: 64 }).notNull(),
  ownerType: ownerTypeEnum("owner_type").notNull().default("PLAYER"),
  ownerId: uuid("owner_id").notNull(),
  quantity: integer("quantity").notNull().default(1),
  category: itemCategoryEnum("category").notNull().default("EQUIPMENT"),
  slot: itemSlotEnum("slot"),
  isEquipped: boolean("is_equipped").notNull().default(false),
  isBound: boolean("is_bound").notNull().default(false),
  isQuestLocked: boolean("is_quest_locked").notNull().default(false),
});

export const itemDefs = pgTable("item_def", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  equipSlot: itemSlotEnum("equip_slot"),
  category: itemCategoryEnum("category").notNull().default("EQUIPMENT"),
  rarity: itemRarityEnum("rarity").notNull().default("N"),
  allowedClasses: varchar("allowed_classes", { length: 512 }).notNull().default("[]"),
  stats: varchar("stats", { length: 1024 }).notNull().default("{}"), // JSON stringified
  stackable: boolean("stackable").notNull().default(false),
  maxStack: integer("max_stack").notNull().default(1),
  buyPrice: integer("buy_price"),
  sellPrice: integer("sell_price"),
});
