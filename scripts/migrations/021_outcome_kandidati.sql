-- A-04 Outcome Watcher: nalezené výsledky jsou pouze návrhy pro lidskou kontrolu.
CREATE TABLE IF NOT EXISTS outcome_kandidati (
  id SERIAL PRIMARY KEY,
  tender_id TEXT NOT NULL,
  zdroj TEXT NOT NULL,
  zdroj_id TEXT,
  nalezeno_at TIMESTAMPTZ DEFAULT NOW(),
  vitez_nazev TEXT,
  vitez_ico TEXT,
  vitezna_cena_bez_dph NUMERIC,
  pocet_uchazecu INTEGER,
  url TEXT,
  shoda_skore NUMERIC,
  raw JSONB,
  stav TEXT NOT NULL DEFAULT 'navrh' CHECK (stav IN ('navrh','potvrzeno','zamitnuto')),
  UNIQUE(tender_id, zdroj, zdroj_id)
);

CREATE INDEX IF NOT EXISTS idx_outcome_kandidati_tender
  ON outcome_kandidati (tender_id, stav, nalezeno_at DESC);
