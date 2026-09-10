CREATE TYPE "public"."fame_tier" AS ENUM('N', 'R', 'SR', 'SSR', 'E', 'L');--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "highest_fame_tier_reached" "fame_tier" DEFAULT 'N' NOT NULL;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "max_hp" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "fame_tier_hp_bonus" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "highest_fame_tier_reached" "fame_tier" DEFAULT 'N' NOT NULL;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "last_regen_calculation_at" timestamp with time zone DEFAULT now() NOT NULL;
