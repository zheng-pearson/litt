export const schemaSql = `
CREATE TABLE IF NOT EXISTS demo_tenants (
  id text PRIMARY KEY,
  telegram_id text NOT NULL UNIQUE,
  email text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','provisioning','active')),
  sandbox_id text UNIQUE,
  secrets text,
  google_app_id text,
  last_gate_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS demo_tickets (
  hash text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES demo_tenants(id),
  kind text NOT NULL CHECK (kind IN ('onboard','login','confirm','connect','callback')),
  payload text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS demo_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES demo_tenants(id),
  kind text NOT NULL CHECK (kind IN ('telegram','provision')),
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_jobs_ready ON demo_jobs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS demo_tickets_expiry ON demo_tickets(expires_at);
CREATE TABLE IF NOT EXISTS demo_mini_sessions (
  hash text PRIMARY KEY,
  init_hash text NOT NULL UNIQUE,
  tenant_id text NOT NULL REFERENCES demo_tenants(id),
  email text,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS demo_mini_sessions_expiry ON demo_mini_sessions(expires_at);
ALTER TABLE demo_tenants ADD COLUMN IF NOT EXISTS merged_into text REFERENCES demo_tenants(id);
ALTER TABLE demo_jobs DROP CONSTRAINT IF EXISTS demo_jobs_kind_check;
ALTER TABLE demo_jobs ADD CONSTRAINT demo_jobs_kind_check CHECK (kind IN ('telegram','whatsapp','provision','oauth_resume','oauth_notice'));
`;
