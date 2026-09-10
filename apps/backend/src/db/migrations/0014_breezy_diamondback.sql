-- Prerequisite for legacy classes HÄNDLER, SPÄHER and MAGIER:
-- A GM/administrator must decide the class of EACH affected player before this
-- migration runs. Do not derive that decision from the legacy class. Record the
-- decision in the change ticket/audit log, then run (outside this migration):
--
--   ALTER TYPE public.player_class ADD VALUE IF NOT EXISTS 'sculptor';
--   ALTER TYPE public.player_class ADD VALUE IF NOT EXISTS 'condottiere';
--   UPDATE public.player SET class = 'sculptor' WHERE id = '<decided-player-id>';
--   UPDATE public.player SET class = 'condottiere' WHERE id = '<decided-player-id>';
--
-- Use one explicit, reviewed UPDATE per player. The guard below deliberately
-- aborts while any undecided legacy value remains.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.player
    WHERE class::text IN ('HÄNDLER', 'SPÄHER', 'MAGIER')
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'player_class migration blocked: HÄNDLER, SPÄHER or MAGIER records still exist',
      HINT = 'A GM/administrator must explicitly assign each affected player to sculptor or condottiere; see the migration header.';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TYPE public.player_class RENAME TO player_class_legacy;
--> statement-breakpoint
CREATE TYPE public.player_class AS ENUM(
  'swiss_guard',
  'cleric',
  'sculptor',
  'condottiere'
);
--> statement-breakpoint
ALTER TABLE public.player
  ALTER COLUMN class TYPE public.player_class
  USING (
    CASE class::text
      WHEN 'GARDIST' THEN 'swiss_guard'
      WHEN 'MÖNCH' THEN 'cleric'
      WHEN 'sculptor' THEN 'sculptor'
      WHEN 'condottiere' THEN 'condottiere'
    END
  )::public.player_class;
--> statement-breakpoint
DROP TYPE public.player_class_legacy;

