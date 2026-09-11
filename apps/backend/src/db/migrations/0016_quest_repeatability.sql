ALTER TABLE "quest_definition"
  ADD COLUMN IF NOT EXISTS "repeatable" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "repeat_cooldown_seconds" integer;

ALTER TABLE "quest_definition"
  ADD CONSTRAINT "quest_definition_repeat_cooldown_nonnegative"
  CHECK ("repeat_cooldown_seconds" IS NULL OR "repeat_cooldown_seconds" >= 0);

-- Existing duplicate open runs have to be resolved deliberately before applying
-- this migration; silently deleting gameplay state would be unsafe.
CREATE UNIQUE INDEX "quest_run_team_definition_open_unique"
  ON "quest_run" ("team_id", "quest_definition_id")
  WHERE "state" IN ('ACTIVE', 'PENDING_REVIEW');
