-- Demo account only: realistic end times (about a minute per km plus 10), and every trip except the
-- Lara burst-pipe callout recorded as logged live when it ended.
UPDATE trips
SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+' || (distance + 10) || ' minutes')
WHERE user_id = (SELECT id FROM users WHERE email = 'demo@odobook.example');

UPDATE trips
SET source = 'live', entered_at = ended_at, late = 0
WHERE user_id = (SELECT id FROM users WHERE email = 'demo@odobook.example')
  AND destination != 'Lara';
