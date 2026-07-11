-- 014_monitoring_zakazky.sql
-- Monitoring: feed nových veřejných zakázek natažených ze zdroje (NEN / Hlídač státu).
-- Jeden řádek = jedna zakázka ze zdroje, deduplikovaná přes UNIQUE(zdroj, zdroj_id).
-- Operátor z feedu zakázku „převezme" (založí složku input/ + CRM stav) nebo „ignoruje".
-- Aplikováno přes runMigrations() při startu. Idempotentní, additivní.

CREATE TABLE IF NOT EXISTS monitoring_zakazky (
  id                    SERIAL PRIMARY KEY,
  zdroj                 TEXT NOT NULL,                 -- 'nen' | 'hlidac'
  zdroj_id              TEXT NOT NULL,                 -- systémové číslo NEN / Id Hlídače
  nazev                 TEXT NOT NULL,
  zadavatel             TEXT,
  predpokladana_hodnota NUMERIC,                       -- často NULL (v seznamu zdroje nebývá)
  lhuta_nabidek         DATE,                          -- NULL když zdroj neuvede
  url                   TEXT,                          -- odkaz na detail zakázky u zdroje
  raw                   JSONB,                         -- původní záznam ze zdroje (audit/debug)
  stav                  TEXT NOT NULL DEFAULT 'nova'
                          CHECK (stav IN ('nova', 'prevzata', 'ignorovana')),
  tender_id             TEXT,                          -- vazba na založenou zakázku po převzetí
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (zdroj, zdroj_id)
);

CREATE INDEX IF NOT EXISTS idx_monitoring_zakazky_stav ON monitoring_zakazky (stav);
CREATE INDEX IF NOT EXISTS idx_monitoring_zakazky_created ON monitoring_zakazky (created_at DESC);
