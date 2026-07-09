-- 011_win_price.sql
-- Win-price inteligence: historická data „co za podobné HW/komodity kdy vyhrálo a za kolik".
-- Zdroj prototypu: Registr smluv (denní XML dumpy data.smlouvy.gov.cz) — vítězná cena + předmět
-- + zadavatel/dodavatel + datum, bez autentizace. Idempotentní upsert dle (zdroj, zdroj_id).
-- Aplikováno přes runMigrations() při startu. Additivní, neničí existující data.
--
-- GDPR pozn.: Registr smluv obsahuje i osobní údaje; predmet/nazev mohou nést jméno FO.
-- Prototyp ukládá jen agregovaná pole (ne přílohy). Produkčně doplnit režim mazání
-- znepřístupněných záznamů (viz docs/win-price-design.md).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS win_prices (
  id               BIGSERIAL PRIMARY KEY,
  zdroj            TEXT NOT NULL,                 -- 'registr_smluv' | 'vvz' | 'ted'
  zdroj_id         TEXT NOT NULL,                 -- ID záznamu ve zdroji (idVerze u Registru smluv)
  datum            DATE,                          -- datum uzavření smlouvy / zadání
  zadavatel_ico    TEXT,
  zadavatel_nazev  TEXT,
  dodavatel_ico    TEXT,                          -- vítěz / dodavatel
  dodavatel_nazev  TEXT,
  predmet          TEXT NOT NULL,                 -- předmět plnění (volný text)
  komodita_kategorie TEXT,                        -- heuristická kategorie (it_av|naradi_dilna|kancelar|ostatni)
  cena_bez_dph     NUMERIC(16,2),
  cena_s_dph       NUMERIC(16,2),
  mena             TEXT DEFAULT 'CZK',
  pocet_uchazecu   INTEGER,                       -- počet nabídek (u Registru smluv není → NULL)
  url              TEXT,
  raw              JSONB,                          -- surová parsovaná pole pro audit / budoucí re-extrakci
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Fulltext nad předmětem (simple config = jazykově neutrální, jako u products).
  search_vector    tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(predmet, ''))
  ) STORED,

  UNIQUE (zdroj, zdroj_id)
);

-- Fulltext + trigram similarity nad předmětem (dvě strategie hledání podobných výher).
CREATE INDEX IF NOT EXISTS idx_win_prices_search   ON win_prices USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_win_prices_trgm      ON win_prices USING GIN (predmet gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_win_prices_datum     ON win_prices (datum DESC);
CREATE INDEX IF NOT EXISTS idx_win_prices_kategorie ON win_prices (komodita_kategorie);
CREATE INDEX IF NOT EXISTS idx_win_prices_dodavatel ON win_prices (dodavatel_ico);
CREATE INDEX IF NOT EXISTS idx_win_prices_raw       ON win_prices USING GIN (raw jsonb_path_ops);
