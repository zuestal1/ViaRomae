CREATE TYPE "public"."status_effect_polarity" AS ENUM('BUFF', 'DEBUFF', 'NEUTRAL');
--> statement-breakpoint
CREATE TYPE "public"."status_effect_duration_type" AS ENUM('ROUNDS', 'TRIGGERS', 'PERMANENT');
--> statement-breakpoint
CREATE TYPE "public"."status_effect_stack_policy" AS ENUM('NONE', 'REFRESH', 'REPLACE_STRONGER', 'STACK');
--> statement-breakpoint
CREATE TYPE "public"."status_effect_persistence_scope" AS ENUM('COMBAT', 'ENCOUNTER', 'PLAYER');
--> statement-breakpoint
CREATE TABLE "status_effect_definition" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"polarity" "status_effect_polarity" NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_type" "status_effect_duration_type" NOT NULL,
	"base_duration" integer NOT NULL,
	"stack_policy" "status_effect_stack_policy" DEFAULT 'REPLACE_STRONGER' NOT NULL,
	"max_stacks" integer DEFAULT 1 NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger_effects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"removable" boolean DEFAULT true NOT NULL,
	"dispel_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"persistence_scope" "status_effect_persistence_scope" DEFAULT 'COMBAT' NOT NULL,
	CONSTRAINT "status_effect_definition_base_duration_check" CHECK ("base_duration" >= 0),
	CONSTRAINT "status_effect_definition_max_stacks_check" CHECK ("max_stacks" > 0)
);
--> statement-breakpoint
CREATE TABLE "status_effect_instance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"combat_instance_id" uuid NOT NULL,
	"effect_id" varchar(128) NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"applied_round" integer NOT NULL,
	"expires_after_round" integer,
	"stacks" integer DEFAULT 1 NOT NULL,
	"magnitude_overrides" jsonb,
	"remaining_triggers" integer,
	"shield_remaining" integer,
	CONSTRAINT "status_effect_instance_round_check" CHECK ("applied_round" >= 0 AND ("expires_after_round" IS NULL OR "expires_after_round" >= "applied_round")),
	CONSTRAINT "status_effect_instance_stacks_check" CHECK ("stacks" > 0),
	CONSTRAINT "status_effect_instance_triggers_check" CHECK ("remaining_triggers" IS NULL OR "remaining_triggers" >= 0),
	CONSTRAINT "status_effect_instance_shield_check" CHECK ("shield_remaining" IS NULL OR "shield_remaining" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ability_cooldown" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"combat_instance_id" uuid NOT NULL,
	"combatant_id" uuid NOT NULL,
	"ability_id" varchar(128) NOT NULL,
	"activated_round" integer NOT NULL,
	"ready_after_round" integer NOT NULL,
	"deactivation_reason" varchar(255),
	CONSTRAINT "ability_cooldown_round_check" CHECK ("activated_round" >= 0 AND "ready_after_round" >= "activated_round")
);
--> statement-breakpoint
ALTER TABLE "status_effect_instance" ADD CONSTRAINT "status_effect_instance_combat_instance_id_combat_instance_id_fk" FOREIGN KEY ("combat_instance_id") REFERENCES "public"."combat_instance"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "status_effect_instance" ADD CONSTRAINT "status_effect_instance_effect_id_status_effect_definition_id_fk" FOREIGN KEY ("effect_id") REFERENCES "public"."status_effect_definition"("id");
--> statement-breakpoint
ALTER TABLE "status_effect_instance" ADD CONSTRAINT "status_effect_instance_source_id_combatant_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."combatant"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "status_effect_instance" ADD CONSTRAINT "status_effect_instance_target_id_combatant_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."combatant"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "ability_cooldown" ADD CONSTRAINT "ability_cooldown_combat_instance_id_combat_instance_id_fk" FOREIGN KEY ("combat_instance_id") REFERENCES "public"."combat_instance"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "ability_cooldown" ADD CONSTRAINT "ability_cooldown_combatant_id_combatant_id_fk" FOREIGN KEY ("combatant_id") REFERENCES "public"."combatant"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "status_effect_instance_target_idx" ON "status_effect_instance" ("target_id");
--> statement-breakpoint
CREATE INDEX "status_effect_instance_combat_idx" ON "status_effect_instance" ("combat_instance_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ability_cooldown_combatant_ability_unique" ON "ability_cooldown" ("combatant_id", "ability_id");
--> statement-breakpoint
CREATE INDEX "ability_cooldown_combat_idx" ON "ability_cooldown" ("combat_instance_id");
