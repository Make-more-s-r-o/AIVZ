-- 007_crm_notifikace.sql
-- CRM (M7): in-app notifikace (zvonek). Příjemce = user id (sub). Best-effort zápis přes notify().
-- Dedup: dokud existuje NEPŘEČTENÁ notifikace pro (user, dedup_key), opakování se potlačí.
-- Aplikováno přes runMigrations() při startu. Idempotentní.

CREATE TABLE IF NOT EXISTS crm_notifikace (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,          -- příjemce (sub)
  typ        TEXT NOT NULL,          -- status_change|assigned|task_assigned|deadline|mention|comment
  text       TEXT NOT NULL,
  url        TEXT,                   -- deep link, např. '#/tender/<id>?tab=komentare'
  tender_id  TEXT,
  entity_typ TEXT,                   -- task|comment|termin|tender
  entity_id  TEXT,
  actor_id   TEXT,
  precteno   BOOLEAN NOT NULL DEFAULT FALSE,
  dedup_key  TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crm_notif_user   ON crm_notifikace (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_notif_unread ON crm_notifikace (user_id) WHERE precteno = FALSE;

-- Dedup: dokud je nepřečtená notifikace pro (user, dedup_key), ON CONFLICT DO NOTHING ji nezaloží znovu.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_notif_dedup
  ON crm_notifikace (user_id, dedup_key) WHERE precteno = FALSE AND dedup_key IS NOT NULL;
