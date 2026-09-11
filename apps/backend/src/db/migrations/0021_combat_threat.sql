CREATE TABLE "combat_threat" (
	"combat_instance_id" uuid NOT NULL REFERENCES "combat_instance"("id") ON DELETE CASCADE,
	"enemy_combatant_id" uuid NOT NULL REFERENCES "combatant"("id") ON DELETE CASCADE,
	"player_combatant_id" uuid NOT NULL REFERENCES "combatant"("id") ON DELETE CASCADE,
	"amount" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "combat_threat_enemy_player_unique" ON "combat_threat" USING btree ("enemy_combatant_id", "player_combatant_id");
--> statement-breakpoint
CREATE INDEX "combat_threat_instance_enemy_idx" ON "combat_threat" USING btree ("combat_instance_id", "enemy_combatant_id");
