ALTER TABLE "combat_instance" ADD COLUMN IF NOT EXISTS "round_started_at" timestamptz;
ALTER TABLE "combat_instance" ADD COLUMN IF NOT EXISTS "action_deadline" timestamptz;
ALTER TABLE "combat_instance" ADD COLUMN IF NOT EXISTS "completed_at" timestamptz;
ALTER TABLE "combat_instance" ADD COLUMN IF NOT EXISTS "outcome" varchar(32);
ALTER TABLE "combat_instance" ADD COLUMN IF NOT EXISTS "winner_team_id" uuid REFERENCES "team"("id");
ALTER TABLE "combat_instance" ADD COLUMN IF NOT EXISTS "resolution_version" integer NOT NULL DEFAULT 0;
ALTER TABLE "combatant" ADD COLUMN IF NOT EXISTS "last_target_id" uuid;
ALTER TABLE "combatant" ADD COLUMN IF NOT EXISTS "mode_multiplier" double precision NOT NULL DEFAULT 1;
ALTER TABLE "player" ADD COLUMN IF NOT EXISTS "last_accuracy" double precision;
ALTER TABLE "item_instance" ADD COLUMN IF NOT EXISTS "is_quest_locked" boolean NOT NULL DEFAULT false;
INSERT INTO "item_def" (id,key,name,equip_slot,category,rarity,allowed_classes,stats,stackable,max_stack,buy_price,sell_price)
VALUES (gen_random_uuid(),'balm_returning','Balsam der Wiederkehr',NULL,'CONSUMABLE','N','[]','{"revivePercent":30,"clericRevivePercent":50}',true,20,120,60)
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,equip_slot=NULL,
  stats=EXCLUDED.stats,stackable=true,buy_price=120;
ALTER TABLE "pvp_challenge" ADD COLUMN IF NOT EXISTS "started_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "pvp_challenge" ADD COLUMN IF NOT EXISTS "escape_confirmations" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "pvp_protection" (
  "team_id" uuid PRIMARY KEY REFERENCES "team"("id") ON DELETE CASCADE,
  "starts_at" timestamptz NOT NULL DEFAULT now(),
  "ends_at" timestamptz NOT NULL,
  "reason" varchar(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS "pvp_loot_resolution" (
  "combat_id" uuid PRIMARY KEY REFERENCES "combat_instance"("id") ON DELETE CASCADE,
  "winner_team_id" uuid NOT NULL REFERENCES "team"("id"),
  "loser_team_id" uuid NOT NULL REFERENCES "team"("id"),
  "transferred" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "resolved_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "combat_revive_request" (
  "request_id" uuid PRIMARY KEY,
  "combat_id" uuid NOT NULL REFERENCES "combat_instance"("id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL REFERENCES "combatant"("id") ON DELETE CASCADE,
  "target_id" uuid NOT NULL REFERENCES "combatant"("id") ON DELETE CASCADE,
  "item_instance_id" uuid NOT NULL,
  "effective_round" integer NOT NULL,
  "hp_percent" integer NOT NULL,
  "applied_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "team_respawn_state" (
  "team_id" uuid PRIMARY KEY REFERENCES "team"("id") ON DELETE CASCADE,
  "combat_id" uuid NOT NULL REFERENCES "combat_instance"("id") ON DELETE CASCADE,
  "world_object_id" uuid NOT NULL REFERENCES "world_object"("id"),
  "state" varchar(32) NOT NULL DEFAULT 'RESPAWN_PENDING',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "recovered_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "boss_contribution_event" (
  "id" uuid PRIMARY KEY,
  "combat_id" uuid NOT NULL REFERENCES "combat_instance"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL REFERENCES "team"("id"),
  "player_id" uuid,
  "event_type" varchar(32) NOT NULL,
  "amount" double precision NOT NULL,
  "round_number" integer NOT NULL,
  "source_action" varchar(128) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "boss_resolution" (
  "combat_id" uuid PRIMARY KEY REFERENCES "combat_instance"("id") ON DELETE CASCADE,
  "result" jsonb NOT NULL,
  "resolved_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "boss_mechanic_response" (
  "request_id" uuid PRIMARY KEY,
  "combat_id" uuid NOT NULL REFERENCES "combat_instance"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL REFERENCES "team"("id"),
  "player_id" uuid NOT NULL,
  "action_type" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("combat_id","player_id","action_type")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pvp_warning_attacker_active_unique"
  ON "pvp_challenge" ("attacker_team_id") WHERE "state" = 'WARNING';
CREATE UNIQUE INDEX IF NOT EXISTS "pvp_warning_defender_active_unique"
  ON "pvp_challenge" ("defender_team_id") WHERE "state" = 'WARNING';
