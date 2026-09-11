-- Complete GDD v0.17 item invariants and consumable catalogue.
ALTER TABLE item_def DROP CONSTRAINT IF EXISTS item_def_category_slot_ck;
ALTER TABLE item_instance DROP CONSTRAINT IF EXISTS item_instance_category_slot_ck;
ALTER TABLE item_def ADD CONSTRAINT item_def_category_slot_ck CHECK
 ((category='EQUIPMENT' AND equip_slot IS NOT NULL) OR (category IN ('CONSUMABLE','QUEST') AND equip_slot IS NULL));
ALTER TABLE item_instance ADD CONSTRAINT item_instance_category_slot_ck CHECK
 ((category='EQUIPMENT' AND slot IS NOT NULL) OR (category IN ('CONSUMABLE','QUEST') AND slot IS NULL AND is_equipped=false));
ALTER TABLE item_instance ADD COLUMN IF NOT EXISTS quest_run_id uuid REFERENCES quest_run(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS combat_item_action(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE,
 combat_action_id uuid NOT NULL UNIQUE REFERENCES combat_action(id) ON DELETE CASCADE,
 item_instance_id uuid NOT NULL REFERENCES item_instance(id), definition_id varchar(64) NOT NULL,
 target_combatant_id uuid REFERENCES combatant(id), resolved_at timestamptz
);

-- One canonical identifier is used by store, inventory UI and combat.
UPDATE store_catalog_item SET definition_id='balm_returning' WHERE definition_id='balsam_der_wiederkehr'
  AND NOT EXISTS (SELECT 1 FROM store_catalog_item current WHERE current.store_id=store_catalog_item.store_id AND current.definition_id='balm_returning');
DELETE FROM store_catalog_item WHERE definition_id='balsam_der_wiederkehr';
UPDATE item_instance SET definition_id='balm_returning' WHERE definition_id='balsam_der_wiederkehr';
DELETE FROM item_def WHERE key='balsam_der_wiederkehr';

INSERT INTO item_def(id,key,name,equip_slot,category,rarity,allowed_classes,stats,stackable,max_stack,buy_price,sell_price) VALUES
 (gen_random_uuid(),'panis_viatoris','Panis Viatoris',NULL,'CONSUMABLE','N','[]','{"heal":20,"contexts":["WORLD"]}',true,10,15,0),
 (gen_random_uuid(),'aqua_vitae','Aqua Vitae',NULL,'CONSUMABLE','N','[]','{"heal":35,"contexts":["WORLD","COMBAT"]}',true,10,30,5),
 (gen_random_uuid(),'aqua_vitae_magna','Aqua Vitae Magna',NULL,'CONSUMABLE','N','[]','{"heal":70,"contexts":["WORLD","COMBAT"]}',true,10,60,10),
 (gen_random_uuid(),'unguentum_medicum','Unguentum Medicum',NULL,'CONSUMABLE','N','[]','{"heal":10,"cleanseDebuffs":1,"contexts":["WORLD","COMBAT"]}',true,10,35,5),
 (gen_random_uuid(),'wetzstein_legionaer','Wetzstein des Legionärs',NULL,'CONSUMABLE','N','[]','{"nextBasicAttackDamagePercent":50,"contexts":["COMBAT"]}',true,10,30,5),
 (gen_random_uuid(),'rauchkugel','Rauchkugel',NULL,'CONSUMABLE','N','[]','{"nextIncomingEnemyDamagePercent":-25,"contexts":["COMBAT"]}',true,10,45,5),
 (gen_random_uuid(),'geweihter_weihrauch','Geweihter Weihrauch',NULL,'CONSUMABLE','N','[]','{"teamIncomingDamagePercent":-15,"enemyPhases":1,"contexts":["COMBAT"]}',true,10,50,10),
 (gen_random_uuid(),'adlerstandarte','Adlerstandarte',NULL,'CONSUMABLE','N','[]','{"teamDamagePercent":15,"rounds":2,"contexts":["COMBAT"]}',true,10,70,10),
 (gen_random_uuid(),'balm_returning','Balsam der Wiederkehr',NULL,'CONSUMABLE','N','[]','{"revivePercent":30,"clericRevivePercent":50,"contexts":["WORLD","COMBAT"]}',true,10,120,20),
 (gen_random_uuid(),'pilgerproviant','Pilgerproviant',NULL,'CONSUMABLE','N','[]','{"teamHeal":25,"contexts":["WORLD"]}',true,10,55,10),
 (gen_random_uuid(),'notfallreliquie','Notfallreliquie',NULL,'CONSUMABLE','N','[]','{"preventDownedHp":1,"autoTrigger":true}',true,10,150,25)
ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name,equip_slot=NULL,category='CONSUMABLE',stats=EXCLUDED.stats,
 stackable=true,max_stack=10,buy_price=EXCLUDED.buy_price,sell_price=EXCLUDED.sell_price;
--> statement-breakpoint
-- GDD 9.10 N bases. Higher rarities are separate definitions/loot variants using the shared multiplier.
INSERT INTO item_def(id,key,name,equip_slot,category,rarity,allowed_classes,stats,stackable,max_stack,buy_price,sell_price) VALUES
 (gen_random_uuid(),'starter_halberd','Hellebarde der Garde','WEAPON','EQUIPMENT','N','["guard"]','{"ATK":4}',false,1,90,15),
 (gen_random_uuid(),'guard_uniform','Gardistenuniform','CLOTHING','EQUIPMENT','N','["guard"]','{"maxHP":15,"INIT":1}',false,1,75,10),
 (gen_random_uuid(),'guard_cuirass','Gardistenkürass','DEFENSE','EQUIPMENT','N','["guard"]','{"DEF":5,"maxHP":5}',false,1,100,15),
 (gen_random_uuid(),'guard_seal','Siegel des Hauptmanns','ARTIFACT','EQUIPMENT','N','["guard"]','{"DEF":2,"maxHP":10}',false,1,105,15),
 (gen_random_uuid(),'starter_pilgrim_staff','Pilgerstab des Ordens','WEAPON','EQUIPMENT','N','["cleric"]','{"ATK":2,"healingPercent":5}',false,1,75,10),
 (gen_random_uuid(),'cleric_habit','Habit des stillen Weges','CLOTHING','EQUIPMENT','N','["cleric"]','{"maxHP":15,"DEF":1}',false,1,75,10),
 (gen_random_uuid(),'cleric_prayerbook','Gebetbuch in Leder','DEFENSE','EQUIPMENT','N','["cleric"]','{"DEF":3,"healingPercent":4}',false,1,80,10),
 (gen_random_uuid(),'cleric_reliquary','Reliquiar des Pilgers','ARTIFACT','EQUIPMENT','N','["cleric"]','{"maxHP":10,"healingPercent":7}',false,1,100,15),
 (gen_random_uuid(),'starter_chisel_hammer','Florentiner Meisselhammer','WEAPON','EQUIPMENT','N','["sculptor"]','{"ATK":4}',false,1,80,10),
 (gen_random_uuid(),'sculptor_apron','Werkstattschürze','CLOTHING','EQUIPMENT','N','["sculptor"]','{"maxHP":10,"INIT":1}',false,1,70,10),
 (gen_random_uuid(),'sculptor_bracer','Lederarmschutz','DEFENSE','EQUIPMENT','N','["sculptor"]','{"DEF":3,"INIT":1}',false,1,75,10),
 (gen_random_uuid(),'sculptor_sketch','Meisterskizze','ARTIFACT','EQUIPMENT','N','["sculptor"]','{"ATK":2,"armorBreakPercentPoints":5}',false,1,90,15),
 (gen_random_uuid(),'starter_side_sword','Italienisches Seitenwehr','WEAPON','EQUIPMENT','N','["condottiere"]','{"ATK":5}',false,1,100,15),
 (gen_random_uuid(),'condottiere_doublet','Söldnerwams','CLOTHING','EQUIPMENT','N','["condottiere"]','{"maxHP":10,"INIT":2}',false,1,80,10),
 (gen_random_uuid(),'condottiere_buckler','Buckler','DEFENSE','EQUIPMENT','N','["condottiere"]','{"DEF":3,"ATK":1}',false,1,90,15),
 (gen_random_uuid(),'condottiere_paybook','Soldbuch des Hauptmanns','ARTIFACT','EQUIPMENT','N','["condottiere"]','{"ATK":2,"INIT":2}',false,1,105,15),
 (gen_random_uuid(),'universal_dagger','Pilgerdolch','WEAPON','EQUIPMENT','N','[]','{"ATK":3}',false,1,70,10),
 (gen_random_uuid(),'universal_cloak','Römischer Reisemantel','CLOTHING','EQUIPMENT','N','[]','{"maxHP":10,"DEF":1}',false,1,60,10),
 (gen_random_uuid(),'universal_shield','Lederschild','DEFENSE','EQUIPMENT','N','[]','{"DEF":3,"maxHP":5}',false,1,70,10),
 (gen_random_uuid(),'universal_fortune_coin','Münze der Fortuna','ARTIFACT','EQUIPMENT','N','[]','{"ATK":1,"DEF":1,"INIT":1}',false,1,75,10)
ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name,equip_slot=EXCLUDED.equip_slot,category='EQUIPMENT',rarity='N',
 allowed_classes=EXCLUDED.allowed_classes,stats=EXCLUDED.stats,stackable=false,max_stack=1,buy_price=EXCLUDED.buy_price,sell_price=EXCLUDED.sell_price;
--> statement-breakpoint
INSERT INTO item_def(id,key,name,equip_slot,category,rarity,allowed_classes,stats,stackable,max_stack,buy_price,sell_price) VALUES
 (gen_random_uuid(),'qi_sigillum_guardiae','Siegel der Schildwacht',NULL,'QUEST','R','[]','{}',false,1,NULL,NULL),
 (gen_random_uuid(),'qi_tessera_lupae','Tessera der Wölfin',NULL,'QUEST','R','[]','{}',false,1,NULL,NULL),
 (gen_random_uuid(),'qi_tabula_agrippae','Wachstafel AGRIPPA',NULL,'QUEST','N','[]','{}',false,1,NULL,NULL),
 (gen_random_uuid(),'qi_ampulla_virgo','Ampulla der Aqua Virgo',NULL,'QUEST','R','[]','{}',false,1,NULL,NULL),
 (gen_random_uuid(),'qi_virga_aesculapii','Stab des Heilwegs',NULL,'QUEST','R','[]','{}',false,1,NULL,NULL),
 (gen_random_uuid(),'qi_plumbum_aquarii','Bleiplombe des Wasseramts',NULL,'QUEST','R','[]','{}',false,1,NULL,NULL)
ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name,equip_slot=NULL,category='QUEST',rarity=EXCLUDED.rarity,
 allowed_classes='[]',stats='{}',stackable=false,max_stack=1,buy_price=NULL,sell_price=NULL;
