-- 008_crm_komentare.sql
-- CRM (M8): týmové komentáře k zakázce + @mention. Soft-delete (deleted_at IS NULL = živý).
-- mentions = JSONB pole user id (sub) zmíněných uživatelů; @mention založí notifikaci (typ 'mention'),
-- řešitel zakázky dostane 'comment' (viz notify() v notif-store, best-effort). author_name = snapshot
-- jména pro zobrazení bez join na users (kdyby byl autor později smazán). tender_id = název složky
-- (žádný FK, stejně jako crm_tasks/crm_terminy). Aplikováno přes runMigrations() při startu. Idempotentní.

CREATE TABLE IF NOT EXISTS crm_komentare (
  id          BIGSERIAL PRIMARY KEY,
  tender_id   TEXT NOT NULL,
  text        TEXT NOT NULL,
  mentions    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- pole user id (sub)
  author_id   TEXT,                                  -- sub autora (null v dev bez JWT)
  author_name TEXT,                                  -- snapshot jména autora
  deleted_at  TIMESTAMPTZ,                           -- soft-delete
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Čtení komentářů zakázky (jen živé, řazeno chronologicky).
CREATE INDEX IF NOT EXISTS idx_crm_koment_tender
  ON crm_komentare (tender_id, created_at) WHERE deleted_at IS NULL;
