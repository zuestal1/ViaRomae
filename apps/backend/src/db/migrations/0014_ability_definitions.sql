-- Player classes use only the canonical GDD ids declared by PlayerClassSchema:
-- guard, cleric, sculptor and condottiere.
ALTER TABLE "combat_action" ADD COLUMN IF NOT EXISTS "ability_id" varchar(64);
ALTER TABLE "combat_action_submission" ADD COLUMN IF NOT EXISTS "ability_id" varchar(64);
CREATE TABLE IF NOT EXISTS "combat_ability_cooldown" (
  "combat_instance_id" uuid NOT NULL REFERENCES "combat_instance"("id") ON DELETE CASCADE,
  "combatant_id" uuid NOT NULL REFERENCES "combatant"("id") ON DELETE CASCADE,
  "ability_id" varchar(64) NOT NULL,
  "available_at_round" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "combat_cooldown_fighter_ability_unique" ON "combat_ability_cooldown" ("combatant_id", "ability_id");
CREATE TABLE IF NOT EXISTS "combat_effect" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "combat_instance_id" uuid NOT NULL REFERENCES "combat_instance"("id") ON DELETE CASCADE,
  "source_combatant_id" uuid NOT NULL REFERENCES "combatant"("id") ON DELETE CASCADE,
  "target_combatant_id" uuid REFERENCES "combatant"("id") ON DELETE CASCADE,
  "ability_id" varchar(64) NOT NULL,
  "expires_at_round" integer,
  "state" jsonb NOT NULL DEFAULT '{}'::jsonb
);
