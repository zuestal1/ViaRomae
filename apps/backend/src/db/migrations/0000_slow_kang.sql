CREATE TYPE "public"."role" AS ENUM('PLAYER', 'GM', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."action_type" AS ENUM('ATTACK', 'DEFEND', 'SKILL', 'FLEE');--> statement-breakpoint
CREATE TYPE "public"."combat_state" AS ENUM('AWAITING_ACTIONS', 'LOCKED', 'RESOLVING', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."combat_type" AS ENUM('PVE', 'PVP', 'BOSS');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('PLAYER', 'ENEMY');--> statement-breakpoint
CREATE TYPE "public"."pvp_challenge_state" AS ENUM('WARNING', 'ESCAPED', 'COMBAT');--> statement-breakpoint
CREATE TYPE "public"."currency_type" AS ENUM('FAME', 'DENARII');--> statement-breakpoint
CREATE TYPE "public"."item_slot" AS ENUM('WEAPON', 'ARMOR', 'ACCESSORY', 'CONSUMABLE');--> statement-breakpoint
CREATE TYPE "public"."ledger_source" AS ENUM('QUEST', 'COMBAT', 'TRADE', 'STORE', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."player_class" AS ENUM('guard', 'cleric', 'sculptor', 'condottiere');--> statement-breakpoint
CREATE TYPE "public"."player_status" AS ENUM('ACTIVE', 'DOWNED');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('DRAFT', 'FIELD_CHECK_REQUIRED', 'EDITORIAL_REVIEW', 'APPROVED');--> statement-breakpoint
CREATE TYPE "public"."world_object_type" AS ENUM('LOCATION', 'ENEMY', 'NPC', 'STORE', 'BOSS', 'SAFE_ZONE');--> statement-breakpoint
CREATE TYPE "public"."flow_phase" AS ENUM('DISCOVER', 'DIALOGUE', 'ACCEPT', 'OBJECTIVE', 'BONUS_OBJECTIVE', 'COMPLETE');--> statement-breakpoint
CREATE TYPE "public"."quest_run_state" AS ENUM('ACTIVE', 'PENDING_REVIEW', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."quest_type" AS ENUM('REGULAR', 'HIDDEN', 'LONG_TERM', 'MEDIA');--> statement-breakpoint
CREATE TYPE "public"."step_action_type" AS ENUM('REACH_LOCATION', 'ANSWER_QUESTION', 'SOLVE_PUZZLE', 'DEFEAT_ENEMY', 'DISCOVER_NPC', 'TALK_TO_NPC', 'ACCEPT_QUEST', 'UPLOAD_MEDIA', 'USE_ITEM', 'CLASS_ACTION', 'TEAM_DECISION', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('UPLOADING', 'RECEIVED', 'IN_REVIEW', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"access_code_hash" text NOT NULL,
	"role" "role" DEFAULT 'PLAYER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token" text NOT NULL,
	"device_id" varchar(128),
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "combat_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"combat_instance_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"action_type" "action_type" NOT NULL,
	"target_id" uuid,
	"is_locked" boolean DEFAULT false NOT NULL,
	"idempotency_key" uuid NOT NULL,
	CONSTRAINT "combat_action_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "combat_instance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "combat_type" NOT NULL,
	"state" "combat_state" DEFAULT 'AWAITING_ACTIONS' NOT NULL,
	"round_number" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "combatant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"combat_instance_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"team_id" uuid,
	"hp_current" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pvp_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attacker_team_id" uuid NOT NULL,
	"defender_team_id" uuid NOT NULL,
	"state" "pvp_challenge_state" DEFAULT 'WARNING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_instance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" varchar(64) NOT NULL,
	"owner_id" uuid NOT NULL,
	"slot" "item_slot" NOT NULL,
	"is_equipped" boolean DEFAULT false NOT NULL,
	"is_bound" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" uuid,
	"currency_type" "currency_type" NOT NULL,
	"amount" integer NOT NULL,
	"source" "ledger_source" NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entry_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "player" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"class" "player_class" NOT NULL,
	"hp_current" integer DEFAULT 100 NOT NULL,
	"status" "player_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_lat" double precision,
	"last_lng" double precision
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(64) NOT NULL,
	"inventory_capacity" integer DEFAULT 40 NOT NULL,
	CONSTRAINT "team_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "play_area" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" integer NOT NULL,
	"geometry_geo_json" text
);
--> statement-breakpoint
CREATE TABLE "world_object" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(128) NOT NULL,
	"type" "world_object_type" NOT NULL,
	"name" varchar(256) NOT NULL,
	"day" varchar(16),
	"cluster" varchar(64),
	"lat" double precision,
	"lng" double precision,
	"discovery_radius_m" integer DEFAULT 55 NOT NULL,
	"interaction_radius_m" integer DEFAULT 15 NOT NULL,
	"exit_hysteresis_radius_m" integer DEFAULT 25 NOT NULL,
	"aggro_radius_m" integer DEFAULT 20 NOT NULL,
	"content_status" "content_status" DEFAULT 'DRAFT' NOT NULL,
	"publishable" boolean DEFAULT false NOT NULL,
	"raw_properties_json" text,
	"content_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "world_object_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "objective_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_run_id" uuid NOT NULL,
	"objective_id" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"progress_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quest_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(64) NOT NULL,
	"title" varchar(128) NOT NULL,
	"type" "quest_type" NOT NULL,
	"day" varchar(16),
	"content_json" text DEFAULT '{}' NOT NULL,
	CONSTRAINT "quest_definition_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "quest_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"quest_definition_id" uuid NOT NULL,
	"state" "quest_run_state" DEFAULT 'ACTIVE' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quest_station" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_object_id" uuid NOT NULL,
	"quest_definition_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" varchar(64) NOT NULL,
	"observable_evidence" text,
	"location_question" text,
	"expected_answer" text,
	"access_fallback_note" text,
	"enemy_hook" varchar(128),
	CONSTRAINT "uq_quest_station_wo_qd_seq" UNIQUE("world_object_id","quest_definition_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "quest_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_definition_id" uuid NOT NULL,
	"step_id" varchar(64) NOT NULL,
	"sequence" integer NOT NULL,
	"flow_phase" "flow_phase" NOT NULL,
	"step_action_type" "step_action_type" NOT NULL,
	"step_category" varchar(32) NOT NULL,
	"gdd_objective_type" varchar(64),
	"target_ref" varchar(128) NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "quest_step_step_id_unique" UNIQUE("step_id")
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" varchar(64) NOT NULL,
	"target_refs" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"quest_run_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"status" "media_status" DEFAULT 'UPLOADING' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combat_action" ADD CONSTRAINT "combat_action_combat_instance_id_combat_instance_id_fk" FOREIGN KEY ("combat_instance_id") REFERENCES "public"."combat_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combatant" ADD CONSTRAINT "combatant_combat_instance_id_combat_instance_id_fk" FOREIGN KEY ("combat_instance_id") REFERENCES "public"."combat_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combatant" ADD CONSTRAINT "combatant_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pvp_challenge" ADD CONSTRAINT "pvp_challenge_attacker_team_id_team_id_fk" FOREIGN KEY ("attacker_team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pvp_challenge" ADD CONSTRAINT "pvp_challenge_defender_team_id_team_id_fk" FOREIGN KEY ("defender_team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player" ADD CONSTRAINT "player_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player" ADD CONSTRAINT "player_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_progress" ADD CONSTRAINT "objective_progress_quest_run_id_quest_run_id_fk" FOREIGN KEY ("quest_run_id") REFERENCES "public"."quest_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_run" ADD CONSTRAINT "quest_run_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_run" ADD CONSTRAINT "quest_run_quest_definition_id_quest_definition_id_fk" FOREIGN KEY ("quest_definition_id") REFERENCES "public"."quest_definition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_station" ADD CONSTRAINT "quest_station_world_object_id_world_object_id_fk" FOREIGN KEY ("world_object_id") REFERENCES "public"."world_object"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_station" ADD CONSTRAINT "quest_station_quest_definition_id_quest_definition_id_fk" FOREIGN KEY ("quest_definition_id") REFERENCES "public"."quest_definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_step" ADD CONSTRAINT "quest_step_quest_definition_id_quest_definition_id_fk" FOREIGN KEY ("quest_definition_id") REFERENCES "public"."quest_definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_account_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_submission" ADD CONSTRAINT "media_submission_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_submission" ADD CONSTRAINT "media_submission_quest_run_id_quest_run_id_fk" FOREIGN KEY ("quest_run_id") REFERENCES "public"."quest_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_submission_id_media_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."media_submission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_reviewer_id_account_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;