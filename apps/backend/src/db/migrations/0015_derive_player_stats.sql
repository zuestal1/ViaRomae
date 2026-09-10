
-- Convert prototype-only class names to the four GDD classes.
UPDATE "player" SET "class" = 'CLERIC' WHERE "class" IN ('MÖNCH', 'MAGIER');
--> statement-breakpoint
UPDATE "player" SET "class" = 'BILDHAUER' WHERE "class" = 'SPÄHER';
--> statement-breakpoint
UPDATE "player" SET "class" = 'CONDOTTIERE' WHERE "class" = 'HÄNDLER';
--> statement-breakpoint
UPDATE "player" SET "hp_current" = LEAST("hp_current", 90) WHERE "class" = 'CLERIC';
--> statement-breakpoint

ALTER TABLE "player"
  ALTER COLUMN "hp_current" DROP DEFAULT,
  ADD COLUMN IF NOT EXISTS "fame_tier_hp" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "permanent_hp" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "temporary_hp" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "permanent_attack" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "temporary_attack" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "permanent_defense" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "temporary_defense" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "permanent_initiative" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "temporary_initiative" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "hp_percent" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "attack_percent" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "defense_percent" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "initiative_percent" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "team" ALTER COLUMN "hp" SET DEFAULT 0;
