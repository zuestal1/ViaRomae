ALTER TYPE "step_action_type" ADD VALUE IF NOT EXISTS 'NAVIGATION_CHALLENGE';
ALTER TYPE "step_action_type" ADD VALUE IF NOT EXISTS 'VISIT_MULTIPLE_LOCATIONS';

CREATE TABLE IF NOT EXISTS "quest_step_waypoint" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "quest_step_id" uuid NOT NULL REFERENCES "quest_step"("id") ON DELETE CASCADE,
  "sequence" integer NOT NULL,
  "target_ref" varchar(128) NOT NULL,
  CONSTRAINT "uq_quest_step_waypoint_sequence" UNIQUE("quest_step_id", "sequence")
);

CREATE TABLE IF NOT EXISTS "quest_waypoint_progress" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "quest_run_id" uuid NOT NULL REFERENCES "quest_run"("id") ON DELETE CASCADE,
  "waypoint_id" uuid NOT NULL REFERENCES "quest_step_waypoint"("id") ON DELETE CASCADE,
  "visited_at" timestamp with time zone DEFAULT now() NOT NULL,
  "visited_by_player_id" uuid NOT NULL REFERENCES "player"("id"),
  CONSTRAINT "uq_quest_waypoint_progress_run_waypoint" UNIQUE("quest_run_id", "waypoint_id")
);
