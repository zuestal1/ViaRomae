ALTER TYPE "public"."player_class" ADD VALUE IF NOT EXISTS 'SCULPTOR';
--> statement-breakpoint
CREATE TYPE "public"."class_unlock_kind" AS ENUM('OPTIONAL_ANSWER', 'HINT', 'BONUS_OBJECTIVE', 'SIDE_QUEST', 'HIDDEN_QUEST_TRIGGER');
--> statement-breakpoint
CREATE TYPE "public"."masterful_eye_subject" AS ENUM('ART', 'FOUNTAIN', 'CHURCH', 'STATUE', 'ARCHITECTURE');
--> statement-breakpoint
CREATE TABLE "quest_class_unlock" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "quest_definition_id" uuid NOT NULL REFERENCES "quest_definition"("id") ON DELETE CASCADE,
  "world_object_id" uuid NOT NULL REFERENCES "world_object"("id") ON DELETE CASCADE,
  "node_id" varchar(64) NOT NULL,
  "option_id" varchar(64) NOT NULL,
  "kind" "class_unlock_kind" NOT NULL,
  "required_class" varchar(32) NOT NULL,
  "subject" "masterful_eye_subject",
  "text" text NOT NULL,
  "effect_json" text DEFAULT '{}' NOT NULL,
  "required" boolean DEFAULT false NOT NULL CHECK ("required" = false),
  "bonus_glory_percent" integer DEFAULT 0 NOT NULL CHECK ("bonus_glory_percent" BETWEEN 0 AND 15),
  "bonus_denarii_percent" integer DEFAULT 0 NOT NULL CHECK ("bonus_denarii_percent" BETWEEN 0 AND 15),
  CONSTRAINT "uq_quest_class_unlock_option" UNIQUE("quest_definition_id", "node_id", "option_id"),
  CONSTRAINT "sculptor_masterful_eye_scope" CHECK (
    "required_class" <> 'SCULPTOR' OR
    ("subject" IS NOT NULL AND "kind" IN ('OPTIONAL_ANSWER', 'HINT', 'BONUS_OBJECTIVE'))
  )
);
--> statement-breakpoint
CREATE TABLE "quest_dialogue_decision" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "quest_run_id" uuid NOT NULL REFERENCES "quest_run"("id") ON DELETE CASCADE,
  "node_id" varchar(64) NOT NULL,
  "option_id" varchar(64) NOT NULL,
  "chosen_by_player_id" uuid NOT NULL REFERENCES "player"("id"),
  "chosen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "uq_quest_dialogue_decision_run_node" UNIQUE("quest_run_id", "node_id")
);
