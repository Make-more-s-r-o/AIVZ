-- Append-only feature vektory skóre v okamžiku obchodního rozhodnutí.
-- Historické řádky se nikdy nepřepisují, aby zůstala zachována kalibrační stopa.

CREATE TABLE IF NOT EXISTS crm_score_snapshots (
  id SERIAL PRIMARY KEY,
  tender_id TEXT NOT NULL,
  typ TEXT NOT NULL CHECK (typ IN ('gonogo', 'bid')),
  skore INTEGER,
  doporuceni TEXT,
  features JSONB NOT NULL,
  kontext TEXT CHECK (kontext IN ('prevzeti', 'match', 'finalize', 'api')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_score_snapshots_tender_typ_latest
  ON crm_score_snapshots (tender_id, typ, created_at DESC);
