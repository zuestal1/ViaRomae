ALTER TABLE "quest_definition" ADD COLUMN IF NOT EXISTS "authored_content" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "quest_run" ADD COLUMN IF NOT EXISTS "runtime_state" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "quest_step" ADD COLUMN IF NOT EXISTS "authored_content" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "media_submission" ADD COLUMN IF NOT EXISTS "mime_type" varchar(128);
ALTER TABLE "media_submission" ADD COLUMN IF NOT EXISTS "file_size_bytes" integer;
UPDATE "media_submission" SET "mime_type"='application/octet-stream', "file_size_bytes"=0 WHERE "mime_type" IS NULL;
ALTER TABLE "media_submission" ALTER COLUMN "mime_type" SET NOT NULL;
ALTER TABLE "media_submission" ALTER COLUMN "file_size_bytes" SET NOT NULL;
ALTER TABLE "review_decision" ADD COLUMN IF NOT EXISTS "criteria" jsonb;

INSERT INTO item_def (id,key,name,equip_slot,category,rarity,allowed_classes,stats,stackable,max_stack,buy_price,sell_price)
VALUES
 (gen_random_uuid(),'qi_sigillum_guardiae','Siegel der Schildwacht',NULL,'CONSUMABLE','R','[]','{}',false,1,NULL,NULL),
 (gen_random_uuid(),'qi_tessera_lupae','Tessera der Wölfin',NULL,'CONSUMABLE','R','[]','{}',false,1,NULL,NULL),
 (gen_random_uuid(),'qi_tabula_agrippae','Wachstafel AGRIPPA',NULL,'CONSUMABLE','N','[]','{}',false,1,NULL,NULL),
 (gen_random_uuid(),'qi_ampulla_virgo','Ampulla der Aqua Virgo',NULL,'CONSUMABLE','R','[]','{}',false,1,NULL,NULL),
 (gen_random_uuid(),'qi_virga_aesculapii','Stab des Heilwegs',NULL,'CONSUMABLE','R','[]','{}',false,1,NULL,NULL),
 (gen_random_uuid(),'qi_plumbum_aquarii','Bleiplombe des Wasseramts',NULL,'CONSUMABLE','R','[]','{}',false,1,NULL,NULL)
ON CONFLICT (key) DO NOTHING;
