-- 009_crm_ulozene_pohledy.sql
-- CRM (M9b): uložené pohledy (saved views) na seznam zakázek. Vlastník = user id (sub).
-- definice = JSONB s filtrem (query, decision, ...). je_sdileny → viditelný celému týmu.
-- Aplikováno přes runMigrations() při startu. Idempotentní, additivní.

CREATE TABLE IF NOT EXISTS crm_ulozene_pohledy (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,                         -- vlastník (sub)
  nazev      TEXT NOT NULL,
  definice   JSONB NOT NULL DEFAULT '{}'::jsonb,    -- {query, decision, ...}
  je_sdileny BOOLEAN NOT NULL DEFAULT FALSE,        -- sdílený s týmem
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_pohledy_user   ON crm_ulozene_pohledy (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_pohledy_shared ON crm_ulozene_pohledy (je_sdileny) WHERE je_sdileny;
