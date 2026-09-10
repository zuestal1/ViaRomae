-- GDD equipment model: consumables are an item category, never an equipment slot.
ALTER TYPE item_slot RENAME TO item_slot_legacy;
CREATE TYPE item_slot AS ENUM ('WEAPON', 'CLOTHING', 'DEFENSE', 'ARTIFACT');
CREATE TYPE item_category AS ENUM ('EQUIPMENT', 'CONSUMABLE');
CREATE TYPE item_rarity AS ENUM ('N', 'R', 'SR', 'SSR', 'E', 'L');

ALTER TABLE item_def
  ADD COLUMN category item_category NOT NULL DEFAULT 'EQUIPMENT',
  ADD COLUMN rarity item_rarity NOT NULL DEFAULT 'N',
  ADD COLUMN allowed_classes varchar(512) NOT NULL DEFAULT '[]';
ALTER TABLE item_instance
  ADD COLUMN category item_category NOT NULL DEFAULT 'EQUIPMENT';

UPDATE item_def SET category = 'CONSUMABLE', equip_slot = NULL
 WHERE equip_slot::text = 'CONSUMABLE';
UPDATE item_instance SET category = 'CONSUMABLE', is_equipped = false
 WHERE slot::text = 'CONSUMABLE';

ALTER TABLE item_def ALTER COLUMN equip_slot TYPE item_slot USING
  CASE equip_slot::text WHEN 'WEAPON' THEN 'WEAPON'::item_slot
    WHEN 'ARMOR' THEN 'CLOTHING'::item_slot
    WHEN 'ACCESSORY' THEN 'ARTIFACT'::item_slot ELSE NULL END;
ALTER TABLE item_instance ALTER COLUMN slot DROP NOT NULL;
ALTER TABLE item_instance ALTER COLUMN slot TYPE item_slot USING
  CASE slot::text WHEN 'WEAPON' THEN 'WEAPON'::item_slot
    WHEN 'ARMOR' THEN 'CLOTHING'::item_slot
    WHEN 'ACCESSORY' THEN 'ARTIFACT'::item_slot ELSE NULL END;
DROP TYPE item_slot_legacy;

ALTER TABLE item_def ADD CONSTRAINT item_def_category_slot_ck CHECK
 ((category = 'EQUIPMENT' AND equip_slot IS NOT NULL) OR
  (category = 'CONSUMABLE' AND equip_slot IS NULL));
ALTER TABLE item_instance ADD CONSTRAINT item_instance_category_slot_ck CHECK
 ((category = 'EQUIPMENT' AND slot IS NOT NULL) OR
  (category = 'CONSUMABLE' AND slot IS NULL AND is_equipped = false));
CREATE UNIQUE INDEX item_instance_one_equipped_per_slot
 ON item_instance(owner_id, slot) WHERE is_equipped;

-- All modifiers are explicitly present; rarity multiplication happens at read time.
UPDATE item_def SET stats=jsonb_build_object(
 'maxHP', COALESCE((stats->>'maxHP')::numeric, 0),
 'ATK', COALESCE((stats->>'ATK')::numeric, (stats->>'atk')::numeric, 0),
 'DEF', COALESCE((stats->>'DEF')::numeric, (stats->>'def')::numeric, 0),
 'INIT', COALESCE((stats->>'INIT')::numeric, 0),
 'INIT_TIE_BREAKER', COALESCE((stats->>'INIT_TIE_BREAKER')::numeric, 0));
INSERT INTO item_def
 (id, key, name, equip_slot, category, rarity, allowed_classes, stats,
  stackable, max_stack, buy_price, sell_price)
VALUES
 (gen_random_uuid(), 'starter_gardist_hellebarde', 'Hellebarde', 'WEAPON', 'EQUIPMENT', 'N', '["GARDIST"]', '{"maxHP":0,"ATK":8,"DEF":0,"INIT":0,"INIT_TIE_BREAKER":0}', false, 1, NULL, NULL),
 (gen_random_uuid(), 'starter_moench_pilgerstab', 'Pilgerstab', 'WEAPON', 'EQUIPMENT', 'N', '["MÖNCH"]', '{"maxHP":0,"ATK":5,"DEF":2,"INIT":0,"INIT_TIE_BREAKER":0}', false, 1, NULL, NULL),
 (gen_random_uuid(), 'starter_haendler_hammer', 'Hammer', 'WEAPON', 'EQUIPMENT', 'N', '["HÄNDLER"]', '{"maxHP":0,"ATK":6,"DEF":1,"INIT":0,"INIT_TIE_BREAKER":0}', false, 1, NULL, NULL),
 (gen_random_uuid(), 'starter_spaeher_schwert', 'Schwert', 'WEAPON', 'EQUIPMENT', 'N', '["SPÄHER"]', '{"maxHP":0,"ATK":6,"DEF":0,"INIT":2,"INIT_TIE_BREAKER":1}', false, 1, NULL, NULL),
 (gen_random_uuid(), 'starter_magier_pilgerstab', 'Pilgerstab', 'WEAPON', 'EQUIPMENT', 'N', '["MAGIER"]', '{"maxHP":0,"ATK":5,"DEF":0,"INIT":1,"INIT_TIE_BREAKER":0}', false, 1, NULL, NULL)
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, equip_slot=EXCLUDED.equip_slot,
 category=EXCLUDED.category, rarity=EXCLUDED.rarity,
 allowed_classes=EXCLUDED.allowed_classes, stats=EXCLUDED.stats;

-- Existing consumables are catalogued correctly and never equipable.
UPDATE item_def SET category='CONSUMABLE', equip_slot=NULL, rarity='N',
 allowed_classes='[]', stats='{"maxHP":0,"ATK":0,"DEF":0,"INIT":0,"INIT_TIE_BREAKER":0}'
 WHERE key='potion_small';
