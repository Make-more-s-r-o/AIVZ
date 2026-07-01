-- 010_crm_stitky.sql
-- CRM (M9b): štítky (tags) k zakázkám. crm_stitky = globální číselník (název unikátní, barva = preset key).
-- zakazka_stitky = M:N vazba zakázka↔štítek (tender_id = název složky, žádný FK na zakázku).
-- Smazání štítku kaskádně odpojí vazby. Aplikováno přes runMigrations() při startu. Idempotentní, additivní.

CREATE TABLE IF NOT EXISTS crm_stitky (
  id         BIGSERIAL PRIMARY KEY,
  nazev      TEXT NOT NULL UNIQUE,
  barva      TEXT NOT NULL DEFAULT 'neutral',   -- preset key (neutral|primary|success|warning|danger|...)
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zakazka_stitky (
  tender_id  TEXT NOT NULL,
  stitek_id  BIGINT NOT NULL REFERENCES crm_stitky(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tender_id, stitek_id)
);

CREATE INDEX IF NOT EXISTS idx_zakazka_stitky_tender ON zakazka_stitky (tender_id);
CREATE INDEX IF NOT EXISTS idx_zakazka_stitky_stitek ON zakazka_stitky (stitek_id);
