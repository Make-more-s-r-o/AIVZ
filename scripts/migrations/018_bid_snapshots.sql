-- 018_bid_snapshots.sql
-- Neměnný otisk nabídky v okamžiku přípravy balíku. Více verzí jedné zakázky
-- je povoleno; výsledek ukazuje na konkrétní poslední snapshot při svém uložení.

CREATE TABLE IF NOT EXISTS bid_snapshots (
  id SERIAL PRIMARY KEY,
  tender_id TEXT NOT NULL,
  snapshot_at TIMESTAMPTZ DEFAULT NOW(),
  zadavatel_nazev TEXT,
  zadavatel_ico TEXT,
  kategorie TEXT,
  zdroj TEXT,
  evidencni_cislo TEXT,
  predpokladana_hodnota NUMERIC,
  lhuta_nabidek DATE,
  pocet_polozek INTEGER,
  nase_cena_bez_dph NUMERIC,
  nase_cena_s_dph NUMERIC,
  nakupni_naklad_bez_dph NUMERIC,
  marze_procent NUMERIC,
  zisk_kc NUMERIC,
  go_no_go_score INTEGER,
  bid_score INTEGER,
  winprice_median NUMERIC,
  winprice_p25 NUMERIC,
  winprice_p75 NUMERIC,
  winprice_n INTEGER,
  podil_overenych_cen NUMERIC,
  podil_orientacnich NUMERIC,
  pocet_hard_flagu INTEGER,
  pocet_warn_flagu INTEGER,
  pocet_kandidat_neexistuje INTEGER,
  validation_fails INTEGER,
  ai_naklad_czk NUMERIC,
  cas_zpracovani_min NUMERIC,
  raw JSONB,
  UNIQUE (tender_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_bid_snapshots_tender_latest
  ON bid_snapshots (tender_id, snapshot_at DESC);

ALTER TABLE crm_vysledky ADD COLUMN IF NOT EXISTS snapshot_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_crm_vysledky_snapshot_id ON crm_vysledky (snapshot_id);
