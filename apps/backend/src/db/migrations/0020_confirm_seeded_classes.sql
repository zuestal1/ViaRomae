UPDATE player
SET class_confirmed = true,
    class_selected_at = COALESCE(class_selected_at, now()),
    class_confirmed_at = COALESCE(class_confirmed_at, now())
WHERE class IS NOT NULL
  AND class_confirmed = false
  AND NOT EXISTS (
    SELECT 1 FROM player occupied
    WHERE occupied.team_id = player.team_id
      AND occupied.class = player.class
      AND occupied.id <> player.id
      AND (occupied.class_confirmed = true OR occupied.id::text < player.id::text)
  );

DROP INDEX IF EXISTS player_team_class_unique;
CREATE UNIQUE INDEX IF NOT EXISTS player_team_confirmed_class_unique
  ON player(team_id, class)
  WHERE class_confirmed = true AND class IS NOT NULL;
