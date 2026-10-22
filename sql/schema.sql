CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'volunteer' CHECK (role IN ('volunteer','coordinator','manager','admin')),
  city TEXT,
  birth_date DATE,
  phone TEXT,
  interests TEXT[] NOT NULL DEFAULT '{}',
  skills TEXT[] NOT NULL DEFAULT '{}',
  experience TEXT,
  participation_format TEXT,
  participation_frequency TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','active','paused','closed')),
  rules_accepted_at TIMESTAMPTZ,
  privacy_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS training_materials (
  id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT, url TEXT,
  required BOOLEAN NOT NULL DEFAULT false, published BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS training_completions (
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  material_id BIGINT REFERENCES training_materials(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id, material_id)
);
CREATE TABLE IF NOT EXISTS opportunities (
  id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
  city TEXT, format TEXT, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','closed')),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS applications (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id BIGINT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','withdrawn')),
  note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, opportunity_id)
);
CREATE TABLE IF NOT EXISTS participation (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id BIGINT REFERENCES opportunities(id) ON DELETE SET NULL,
  title TEXT NOT NULL, participated_on DATE NOT NULL DEFAULT CURRENT_DATE,
  hours NUMERIC(6,2) NOT NULL CHECK (hours >= 0), note TEXT,
  recorded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY, actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS applications_user_idx ON applications(user_id);
CREATE INDEX IF NOT EXISTS participation_user_idx ON participation(user_id);
CREATE INDEX IF NOT EXISTS opportunities_status_idx ON opportunities(status);
