-- 015_warehouse_web_findings.sql
-- Nákupní nálezy z webového ověření cen. Jde o oddělenou znalost pro nákup po
-- výhře; tabulka se nepoužívá pro warehouse matching.

CREATE TABLE IF NOT EXISTS warehouse_web_findings (
  id             SERIAL PRIMARY KEY,
  tender_id      TEXT NOT NULL,
  polozka_index  INTEGER NOT NULL,
  polozka_nazev  TEXT NOT NULL,
  produkt        TEXT,
  dodavatel      TEXT,
  url             TEXT NOT NULL,
  cena_bez_dph   NUMERIC,
  cena_s_dph     NUMERIC,
  dostupnost     TEXT,
  zdroj          TEXT NOT NULL DEFAULT 'web_verify',
  found_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tender_id, polozka_index, url)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_web_findings_tender
  ON warehouse_web_findings (tender_id, polozka_index);

