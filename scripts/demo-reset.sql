-- Demo account only: undo a recording take. Removes every trip entered after the seed
-- (seeded trips were all entered by 2026-10-22 20:32 UTC) and puts the car model back.
-- Run: npx wrangler d1 execute odobook --remote --file=scripts/demo-reset.sql
DELETE FROM amendments WHERE trip_id IN (
  SELECT id FROM trips
  WHERE user_id = (SELECT id FROM users WHERE email = 'demo@odobook.example')
    AND entered_at > '2026-10-22T20:40:00Z'
);

DELETE FROM trips
WHERE user_id = (SELECT id FROM users WHERE email = 'demo@odobook.example')
  AND entered_at > '2026-10-22T20:40:00Z';

UPDATE logbooks SET model = 'HiLux'
WHERE user_id = (SELECT id FROM users WHERE email = 'demo@odobook.example');
