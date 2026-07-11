-- 012_crm_vysledky.sql
-- CRM: výsledky podaných nabídek (win-rate feedback loop). Jeden řádek na zakázku
-- (tender_id = název složky, žádný FK — vzor crm_terminy). Výhra/prohra/zrušeno +
-- ceny pro výpočet win-rate a odchylky od vítěze; vítězná cena se navíc propisuje
-- do win_prices (zdroj 'vlastni_vysledek') jako učicí signál pro win-price band.
-- Aplikováno přes runMigrations() při startu. Idempotentní, additivní.

CREATE TABLE IF NOT EXISTS crm_vysledky (
  id                    SERIAL PRIMARY KEY,
  tender_id             TEXT UNIQUE NOT NULL,
  vysledek              TEXT NOT NULL CHECK (vysledek IN ('vyhra', 'prohra', 'zruseno')),
  vitezna_cena_bez_dph  NUMERIC,      -- cena vítěze (u výhry typicky = nase_cena_bez_dph)
  nase_cena_bez_dph     NUMERIC,      -- naše podaná cena
  pocet_uchazecu        INTEGER,
  vitez_nazev           TEXT,
  poznamka              TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_vysledky_vysledek ON crm_vysledky (vysledek);
