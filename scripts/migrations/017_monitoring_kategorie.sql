-- 017_monitoring_kategorie.sql
-- Komoditní kategorie monitorované zakázky. Starší řádky se doplní líně při čtení,
-- protože kategorizace je aplikační heuristika a nepatří do jednorázového SQL backfillu.

ALTER TABLE monitoring_zakazky
  ADD COLUMN IF NOT EXISTS kategorie TEXT;

CREATE INDEX IF NOT EXISTS idx_monitoring_zakazky_kategorie
  ON monitoring_zakazky (kategorie);
