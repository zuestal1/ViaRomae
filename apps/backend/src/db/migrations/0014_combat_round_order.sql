CREATE TABLE IF NOT EXISTS "combat_round_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "combat_instance_id" uuid NOT NULL REFERENCES "combat_instance"("id") ON DELETE CASCADE,
  "round_number" integer NOT NULL,
  "actor_id" uuid NOT NULL,
  "effective_initiative" integer NOT NULL,
  "equipment_rarity_score" integer NOT NULL,
  "round_random" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "combat_round_order_instance_round_actor_unique"
  ON "combat_round_order" ("combat_instance_id", "round_number", "actor_id");
