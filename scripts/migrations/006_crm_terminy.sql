-- 006_crm_terminy.sql
-- CRM (M6): perzistentní termíny/lhůty zakázky (podklad pro Kalendář + M7 připomínky).
-- tender_id = název složky zakázky (žádný FK). Seedováno z analysis.terminy, uživatelsky editovatelné.
-- Aplikováno přes runMigrations() při startu. Idempotentní.

CREATE TABLE IF NOT EXISTS crm_terminy (
  id             BIGSERIAL PRIMARY KEY,
  tender_id      TEXT NOT NULL,
  typ            TEXT NOT NULL,          -- lhuta_nabidek|otevirani_obalek|doba_plneni|prohlidka|vlastni
  datum          DATE NOT NULL,
  cas            TEXT,                   -- volitelně 'HH:MM'
  popis          TEXT,
  pripominka     INTEGER,               -- dní předem; NULL = žádná
  pripomenuto_at TIMESTAMPTZ,           -- marker odeslané připomínky (dedup pro M7 sweep)
  seed_key       TEXT,                  -- 'analysis:<pole>'; NULL u ručních
  created_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_terminy_tender ON crm_terminy (tender_id, datum);
CREATE INDEX IF NOT EXISTS idx_crm_terminy_datum  ON crm_terminy (datum);

-- Idempotentní seed z analýzy: (tender_id, seed_key) unikátní jen pro seedované řádky.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_terminy_seed
  ON crm_terminy (tender_id, seed_key) WHERE seed_key IS NOT NULL;
