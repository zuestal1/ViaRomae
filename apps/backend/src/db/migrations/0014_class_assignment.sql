ALTER TABLE "player" ALTER COLUMN "class" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "class_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "class_selected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "class_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "class_assigned_by" uuid;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "preflight_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player" ADD CONSTRAINT "player_class_assigned_by_account_id_fk" FOREIGN KEY ("class_assigned_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Existing assignments predate the selection flow and are treated as binding GM setup.
UPDATE "player" SET "class_confirmed" = true, "class_selected_at" = now(), "class_confirmed_at" = now() WHERE "class" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "player_team_confirmed_class_unique" ON "player" USING btree ("team_id", "class") WHERE "class_confirmed" = true AND "class" IS NOT NULL;
