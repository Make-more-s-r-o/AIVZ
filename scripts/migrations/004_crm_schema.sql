-- 004_crm_schema.sql
-- CRM (M2): perzistovaný lifecycle stav zakázky + append-only log aktivit.
-- tender_id = název složky zakázky (input/output/{tender_id}); tendery žijí v souborech,
-- proto žádný FK. Aplikováno přes runMigrations() při startu serve-api.
-- Vytvořeno: 2026-06-30

-- Perzistovaný stav zakázky (1 řádek na zakázku). Když řádek chybí, frontend
-- spadne zpět na odvozenou fázi z pipeline kroků (deriveStage).
CREATE TABLE IF NOT EXISTS crm_tender_status (
  tender_id  TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  assignee   TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Append-only audit log (status_change, assignment, …). Nikdy se needituje/nemaže.
CREATE TABLE IF NOT EXISTS crm_activity (
  id         BIGSERIAL PRIMARY KEY,
  tender_id  TEXT NOT NULL,
  type       TEXT NOT NULL,
  actor_id   TEXT,
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_activity_tender ON crm_activity (tender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activity_recent ON crm_activity (created_at DESC);
