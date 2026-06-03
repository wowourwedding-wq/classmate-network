-- ClassMate School Network — D1 schema
-- Run once when setting up the database:
--   wrangler d1 execute classmate-network-db --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS schools (
  id            TEXT PRIMARY KEY,                  -- uuid
  code          TEXT UNIQUE NOT NULL,              -- 8-char school code (e.g. ZW-7K3M)
  name          TEXT NOT NULL,
  country       TEXT NOT NULL,                     -- 'ZW' / 'ZA' / 'ZM'
  contact_email TEXT,
  contact_phone TEXT,
  plan          TEXT NOT NULL DEFAULT 'free',      -- 'free' / 'school' / 'premium'
  upload_count  INTEGER NOT NULL DEFAULT 0,
  trust_level   INTEGER NOT NULL DEFAULT 0,        -- 0 = needs moderation, 1 = auto-approve, 2 = trusted admin
  admin_pin     TEXT,                              -- hashed pin for admin actions (optional)
  created_at    INTEGER NOT NULL                   -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_schools_code    ON schools(code);
CREATE INDEX IF NOT EXISTS idx_schools_country ON schools(country);

CREATE TABLE IF NOT EXISTS teachers (
  id         TEXT PRIMARY KEY,
  school_id  TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name       TEXT,
  phone      TEXT,
  role       TEXT,                                 -- 'teacher' / 'head' / 'hod'
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_teachers_school ON teachers(school_id);

CREATE TABLE IF NOT EXISTS papers (
  id              TEXT PRIMARY KEY,
  school_id       TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id      TEXT REFERENCES teachers(id),
  title           TEXT NOT NULL,
  subject         TEXT,
  level           TEXT,                            -- curriculum-specific level key
  grade           TEXT,
  year            TEXT,
  paper_number    TEXT,
  curriculum      TEXT,                            -- 'zimsec' / 'caps' / 'ecz' / 'cambridge' / 'school-set'
  country         TEXT NOT NULL,                   -- 'ZW' / 'ZA' / 'ZM'
  r2_key          TEXT NOT NULL,                   -- R2 object key
  file_size       INTEGER,
  content_type    TEXT,
  visibility      TEXT NOT NULL DEFAULT 'country', -- 'private' / 'country' / 'network'
  mod_status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' / 'approved' / 'rejected'
  mod_reason      TEXT,
  download_count  INTEGER NOT NULL DEFAULT 0,
  flag_count      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_papers_feed   ON papers(country, mod_status, visibility, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_papers_school ON papers(school_id);
CREATE INDEX IF NOT EXISTS idx_papers_subj   ON papers(subject, level, grade);

CREATE TABLE IF NOT EXISTS flags (
  id          TEXT PRIMARY KEY,
  paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  flagged_by  TEXT,                                -- school_id of flagger
  reason      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flags_paper ON flags(paper_id);
