CREATE TYPE "public"."combat_action_origin" AS ENUM('PLAYER_SUBMITTED', 'AUTOMATIC', 'ENEMY_AI');
--> statement-breakpoint
ALTER TABLE "combat_action" ADD COLUMN "origin" "combat_action_origin" DEFAULT 'PLAYER_SUBMITTED' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "combat_action_instance_round_actor_unique" ON "combat_action" USING btree ("combat_instance_id", "round_number", "actor_id");
--> statement-breakpoint
CREATE TABLE "combat_action_submission" (
  "idempotency_key" uuid PRIMARY KEY NOT NULL,
  "action_id" uuid NOT NULL,
  "combat_instance_id" uuid NOT NULL,
  "round_number" integer NOT NULL,
  "actor_id" uuid NOT NULL,
  "action_type" "action_type" NOT NULL,
  "target_id" uuid,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
