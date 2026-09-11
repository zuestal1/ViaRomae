ALTER TABLE "media_submission" ADD COLUMN "step_id" varchar(64);
UPDATE "media_submission" ms
SET "step_id" = step.step_id
FROM "quest_run" run
JOIN LATERAL (
  SELECT qs.step_id
  FROM "quest_step" qs
  WHERE qs.quest_definition_id = run.quest_definition_id
    AND qs.step_action_type = 'UPLOAD_MEDIA'
  ORDER BY qs.sequence
  LIMIT 1
) step ON true
WHERE run.id = ms.quest_run_id;
DELETE FROM "media_submission" WHERE "step_id" IS NULL;
ALTER TABLE "media_submission" ALTER COLUMN "step_id" SET NOT NULL;
CREATE UNIQUE INDEX "review_decision_submission_unique" ON "review_decision" ("submission_id");
