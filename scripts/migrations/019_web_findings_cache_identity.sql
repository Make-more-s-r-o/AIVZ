-- Identita produktu pro řízené opětovné použití webových nálezů.
ALTER TABLE warehouse_web_findings
  ADD COLUMN IF NOT EXISTS katalogove_cislo TEXT,
  ADD COLUMN IF NOT EXISTS vyrobce TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT;

CREATE INDEX IF NOT EXISTS idx_warehouse_web_findings_katalogove_cislo
  ON warehouse_web_findings ((LOWER(TRANSLATE(BTRIM(katalogove_cislo),
    'áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ',
    'acdeeinorstuuyzACDEEINORSTUUYZ'))))
  WHERE katalogove_cislo IS NOT NULL;
