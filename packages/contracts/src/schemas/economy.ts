import { z } from "zod";

export const CurrencyTypeSchema = z.enum(["FAME", "DENARII"]);
export type CurrencyType = z.infer<typeof CurrencyTypeSchema>;

export const LedgerSourceSchema = z.enum([
  "QUEST",
  "COMBAT",
  "TRADE",
  "STORE",
  "ADMIN",
]);
export type LedgerSource = z.infer<typeof LedgerSourceSchema>;

export const LedgerEntrySchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  playerId: z.string().uuid().nullable(),
  currencyType: CurrencyTypeSchema,
  amount: z.number().int(),
  source: LedgerSourceSchema,
  idempotencyKey: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const ItemSlotSchema = z.enum([
  "WEAPON",
  "CLOTHING",
  "DEFENSE",
  "ARTIFACT",
]);
export type ItemSlot = z.infer<typeof ItemSlotSchema>;
export const ItemCategorySchema = z.enum(["EQUIPMENT", "CONSUMABLE"]);
export type ItemCategory = z.infer<typeof ItemCategorySchema>;
export const ItemRaritySchema = z.enum(["N", "R", "SR", "SSR", "E", "L"]);
export type ItemRarity = z.infer<typeof ItemRaritySchema>;
export const ItemStatsSchema = z.object({
  maxHP: z.number().default(0), ATK: z.number().default(0),
  DEF: z.number().default(0), INIT: z.number().default(0),
  INIT_TIE_BREAKER: z.number().default(0),
});
export type ItemStats = z.infer<typeof ItemStatsSchema>;

export const ItemDefinitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  category: ItemCategorySchema,
  equipSlot: ItemSlotSchema.nullable(),
  rarity: ItemRaritySchema,
  allowedClasses: z.array(z.string()),
  stats: ItemStatsSchema,
});
export type ItemDefinition = z.infer<typeof ItemDefinitionSchema>;

export const EquipmentComparisonSchema = z.object({
  old: ItemStatsSchema,
  new: ItemStatsSchema,
  difference: ItemStatsSchema,
});
export const EquipItemResponseSchema = z.object({
  equipped: z.string().uuid(),
  slot: ItemSlotSchema,
  comparison: EquipmentComparisonSchema,
});
export type EquipItemResponse = z.infer<typeof EquipItemResponseSchema>;

export const ItemInstanceSchema = z.object({
  id: z.string().uuid(),
  definitionId: z.string(),
  name: z.string().optional(),
  ownerType: z.enum(["PLAYER", "TEAM"]).optional(),
  ownerId: z.string().uuid(),
  quantity: z.number().int().optional(),
  category: ItemCategorySchema,
  slot: ItemSlotSchema.nullable(),
  isEquipped: z.boolean(),
  isBound: z.boolean(),
  isQuestLocked: z.boolean().optional().default(false),
  stats: z.record(z.number()).optional(),
  effectiveStats: ItemStatsSchema.optional(),
  rarity: ItemRaritySchema,
  allowedClasses: z.array(z.string()),
  canEquip: z.boolean(),
  unusableReason: z.string().nullable(),
  stackable: z.boolean().optional(),
});
export type ItemInstance = z.infer<typeof ItemInstanceSchema>;

export const InventoryListResponseSchema = z.object({
  items: z.array(ItemInstanceSchema),
});
export type InventoryListResponse = z.infer<typeof InventoryListResponseSchema>;

export const EconomySummarySchema = z.object({
  fame: z.number().int(),
  denarii: z.number().int(),
  equippedStats: z.record(z.number()),
  playerCount: z.number().int(),
  teamCount: z.number().int(),
  playerLimit: z.number().int(),
  teamLimit: z.number().int(),
});
export type EconomySummary = z.infer<typeof EconomySummarySchema>;

export const StoreCatalogItemSchema = z.object({
  definitionId: z.string(),
  name: z.string(),
  category: ItemCategorySchema,
  price: z.number().int().positive(),
  sellPrice: z.number().int().nonnegative(),
  stackable: z.boolean(),
});
export type StoreCatalogItem = z.infer<typeof StoreCatalogItemSchema>;

export const StoreCatalogResponseSchema = z.object({
  storeId: z.string().uuid(),
  externalId: z.string(),
  name: z.string(),
  denarii: z.number().int(),
  interactionAllowed: z.boolean(),
  blockedReason: z.string().nullable(),
  items: z.array(StoreCatalogItemSchema),
});
export type StoreCatalogResponse = z.infer<typeof StoreCatalogResponseSchema>;

export const StorePurchaseRequestSchema = z.object({
  idempotencyKey: z.string().uuid(),
  definitionId: z.string().min(1),
  quantity: z.number().int().min(1).max(40),
});
export type StorePurchaseRequest = z.infer<typeof StorePurchaseRequestSchema>;

export const StoreSaleRequestSchema = z.object({
  idempotencyKey: z.string().uuid(),
  itemInstanceId: z.string().uuid(),
  quantity: z.number().int().min(1).max(40),
});
export type StoreSaleRequest = z.infer<typeof StoreSaleRequestSchema>;

export const StoreTransactionResponseSchema = z.object({
  transactionId: z.string().uuid(),
  alreadyProcessed: z.boolean(),
  kind: z.enum(["BUY", "SELL"]),
  definitionId: z.string(),
  quantity: z.number().int().positive(),
  amount: z.number().int(),
  denarii: z.number().int(),
});
export type StoreTransactionResponse = z.infer<typeof StoreTransactionResponseSchema>;

export const TeamListEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type TeamListEntry = z.infer<typeof TeamListEntrySchema>;

export const TradeRequestSchema = z.object({
  idempotencyKey: z.string().uuid(),
  receiverTeamId: z.string().uuid(),
  items: z
    .array(
      z.object({
        itemInstanceId: z.string().uuid(),
        quantity: z.number().int().min(1),
      }),
    )
    .optional()
    .default([]),
  currencies: z
    .array(
      z.object({
        currencyType: CurrencyTypeSchema,
        amount: z.number().int(),
      }),
    )
    .optional()
    .default([]),
});
export type TradeRequest = z.infer<typeof TradeRequestSchema>;

export const TradeSideSchema = z.object({
  items: z.array(
    z.object({
      itemInstanceId: z.string().uuid(),
      quantity: z.number().int().min(1),
    }),
  ),
  denarii: z.number().int().nonnegative(),
  itemLabels: z.array(z.string()).optional(),
});
export type TradeSide = z.infer<typeof TradeSideSchema>;

export const TradeOfferSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["OPEN", "ACCEPTED", "REJECTED", "CANCELLED"]),
  initiatorTeamId: z.string().uuid(),
  counterpartyTeamId: z.string().uuid(),
  initiatorName: z.string(),
  counterpartyName: z.string(),
  initiatorPayload: TradeSideSchema,
  counterpartyPayload: TradeSideSchema.nullable(),
  createdAt: z.string(),
});
export type TradeOffer = z.infer<typeof TradeOfferSchema>;

export const TradeOfferListSchema = z.object({
  incoming: z.array(TradeOfferSchema),
  outgoing: z.array(TradeOfferSchema),
});
export type TradeOfferList = z.infer<typeof TradeOfferListSchema>;

export const RewardItemGrantedSchema = z.object({
  defKey: z.string(),
  quantity: z.number().int(),
  owner: z.enum(["PLAYER", "TEAM"]),
});
export type RewardItemGranted = z.infer<typeof RewardItemGrantedSchema>;
