-- Odobook (Alexa+ MCP) schema for Cloudflare D1.
-- Distances are whole units of the logbook's unit (km for AU, miles for US).
-- Times are ISO 8601 UTC; each logbook keeps its own IANA time zone for display.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  pw_hash     TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logbooks (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  jurisdiction    TEXT NOT NULL CHECK (jurisdiction IN ('AU', 'US')),
  unit            TEXT NOT NULL CHECK (unit IN ('km', 'mi')),
  time_zone       TEXT NOT NULL,
  make            TEXT NOT NULL,
  model           TEXT NOT NULL,
  rego            TEXT NOT NULL,
  engine_cc       INTEGER,
  start_date      TEXT NOT NULL,          -- YYYY-MM-DD, local
  planned_end     TEXT NOT NULL,          -- YYYY-MM-DD, local
  start_odometer  INTEGER NOT NULL,
  closed_at       TEXT,
  end_odometer    INTEGER,
  business_pct    REAL,                   -- frozen when closed
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logbooks_user ON logbooks(user_id, closed_at);

CREATE TABLE IF NOT EXISTS trips (
  id              TEXT PRIMARY KEY,
  logbook_id      TEXT NOT NULL REFERENCES logbooks(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,                   -- null while the trip is under way
  start_odometer  INTEGER,
  end_odometer    INTEGER,
  distance        INTEGER,
  kind            TEXT CHECK (kind IN ('business', 'private')),
  purpose         TEXT,
  destination     TEXT,
  source          TEXT NOT NULL CHECK (source IN ('live', 'manual')),
  entered_at      TEXT NOT NULL,          -- when the trip was recorded (late-entry check)
  late            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trips_logbook ON trips(logbook_id, started_at);
CREATE INDEX IF NOT EXISTS trips_open ON trips(user_id, ended_at);

CREATE TABLE IF NOT EXISTS amendments (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  at          TEXT NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  reason      TEXT
);
