-- Normalizovaný název položky je poslední, slabý klíč cache pro historické nálezy.
ALTER TABLE warehouse_web_findings
  ADD COLUMN IF NOT EXISTS nazev_polozky TEXT;

CREATE INDEX IF NOT EXISTS idx_warehouse_web_findings_nazev_polozky
  ON warehouse_web_findings (nazev_polozky)
  WHERE nazev_polozky IS NOT NULL;
