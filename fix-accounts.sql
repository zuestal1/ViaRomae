-- Delete broken accounts
DELETE FROM player WHERE account_id IN (SELECT id FROM account WHERE username IN ('testuser', 'gm'));
DELETE FROM account WHERE username IN ('testuser', 'gm');

-- Create accounts with correct scrypt hash for 'test123'
INSERT INTO account (username, access_code_hash, role) VALUES 
  ('testuser', 'scrypt:68063842c6440792b602463c3b668813:059dbb35436fb7126ca1cde9c302b42258d3730cfb91f298cd04f7d681bef97e0efc0fdf0d0e7e36406281287b8bb71019db29dc00d268e373206ce4bfc03da8', 'PLAYER'),
  ('gm', 'scrypt:68063842c6440792b602463c3b668813:059dbb35436fb7126ca1cde9c302b42258d3730cfb91f298cd04f7d681bef97e0efc0fdf0d0e7e36406281287b8bb71019db29dc00d268e373206ce4bfc03da8', 'GM');

-- Create team and player for testuser
WITH acc AS (
  SELECT id FROM account WHERE username = 'testuser' LIMIT 1
),
new_team AS (
  INSERT INTO team (name, inventory_capacity) 
  VALUES ('Test Team', 40) 
  RETURNING id
)
INSERT INTO player (account_id, team_id, class, hp_current, status)
SELECT acc.id, new_team.id, 'swiss_guard', 100, 'ACTIVE'
FROM acc, new_team;

-- Verify
SELECT username, LEFT(access_code_hash, 30) as hash_prefix, role FROM account WHERE username IN ('testuser', 'gm');
