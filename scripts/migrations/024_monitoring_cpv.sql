-- Prvotřídní CPV klasifikace monitorované zakázky.
-- Historické řádky zůstávají s prázdným polem a doplní je následující idempotentní sync;
-- raw payload může obsahovat více různých tvarů CPV, které bezpečně normalizuje aplikace.

ALTER TABLE monitoring_zakazky
  ADD COLUMN IF NOT EXISTS cpv TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

CREATE INDEX IF NOT EXISTS idx_monitoring_zakazky_cpv
  ON monitoring_zakazky USING GIN (cpv);
