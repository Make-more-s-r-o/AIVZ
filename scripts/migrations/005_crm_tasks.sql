-- 005_crm_tasks.sql
-- CRM (M3): per-tender úkoly + auto-seedovaný checklist z analysis.kvalifikace[].
-- tender_id = název složky zakázky (žádný FK; tendery žijí v souborech, ne v DB).
-- Aplikováno přes runMigrations() při startu serve-api. Idempotentní (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS crm_tasks (
  id           BIGSERIAL PRIMARY KEY,
  tender_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  assignee     TEXT,                                   -- user id (sub); NULL = nepřiřazeno
  due_date     DATE,                                   -- volitelné
  stav         TEXT NOT NULL DEFAULT 'k_vyrizeni',     -- k_vyrizeni|probiha|hotovo|blokovano
  priorita     TEXT NOT NULL DEFAULT 'stredni',        -- nizka|stredni|vysoka
  je_checklist BOOLEAN NOT NULL DEFAULT FALSE,
  seed_key     TEXT,                                   -- content-hash seed položky; NULL u ručních úkolů
  created_by   TEXT,                                   -- actor id, kdo úkol vytvořil
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ                             -- vyplněno při přechodu na 'hotovo'
);

CREATE INDEX IF NOT EXISTS idx_crm_tasks_tender   ON crm_tasks (tender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_assignee ON crm_tasks (assignee) WHERE assignee IS NOT NULL;

-- Idempotentní seed: (tender_id, seed_key) unikátní JEN pro seedované řádky.
-- Ruční úkoly mají seed_key NULL a partial index je ignoruje → žádné omezení.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_tasks_seed
  ON crm_tasks (tender_id, seed_key) WHERE seed_key IS NOT NULL;
