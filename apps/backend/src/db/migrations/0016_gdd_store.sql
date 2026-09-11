-- GDD v0.17 / Pfäffikon vertical-slice store support.
ALTER TABLE "player" ADD COLUMN IF NOT EXISTS "last_location_accuracy" double precision;
ALTER TABLE "player" ADD COLUMN IF NOT EXISTS "valid_location_streak" integer NOT NULL DEFAULT 0;
ALTER TABLE "item_instance" ADD COLUMN IF NOT EXISTS "is_quest_locked" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "store_catalog_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "world_object"("id") ON DELETE CASCADE,
  "definition_id" varchar(64) NOT NULL REFERENCES "item_def"("key"),
  "price" integer NOT NULL CHECK ("price" > 0),
  CONSTRAINT "store_catalog_store_definition_unique" UNIQUE("store_id", "definition_id")
);

CREATE TABLE IF NOT EXISTS "store_transaction" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" uuid NOT NULL UNIQUE,
  "store_id" uuid NOT NULL REFERENCES "world_object"("id"),
  "team_id" uuid NOT NULL REFERENCES "team"("id"),
  "player_id" uuid NOT NULL REFERENCES "player"("id"),
  "kind" varchar(4) NOT NULL CHECK ("kind" IN ('BUY', 'SELL')),
  "definition_id" varchar(64) NOT NULL REFERENCES "item_def"("key"),
  "quantity" integer NOT NULL CHECK ("quantity" > 0),
  "amount" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
