ALTER TYPE player_class ADD VALUE IF NOT EXISTS 'guard';
ALTER TYPE player_class ADD VALUE IF NOT EXISTS 'cleric';
ALTER TYPE player_class ADD VALUE IF NOT EXISTS 'sculptor';
ALTER TYPE player_class ADD VALUE IF NOT EXISTS 'condottiere';

ALTER TABLE player ADD COLUMN IF NOT EXISTS class_bound_at timestamptz;
ALTER TABLE player ADD COLUMN IF NOT EXISTS last_regen_calculation_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS player_team_class_unique ON player(team_id, class);

CREATE TABLE IF NOT EXISTS player_class_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid NOT NULL REFERENCES player(id),
  previous_class player_class, new_class player_class NOT NULL, reason text NOT NULL,
  gm_account_id uuid NOT NULL REFERENCES account(id), created_at timestamptz NOT NULL DEFAULT now()
);
