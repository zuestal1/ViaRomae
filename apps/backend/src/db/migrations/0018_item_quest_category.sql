-- PostgreSQL requires a newly added enum value to be committed before it is used.
ALTER TYPE item_category ADD VALUE IF NOT EXISTS 'QUEST';
