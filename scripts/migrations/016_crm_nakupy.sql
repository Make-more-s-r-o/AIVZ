-- 016_crm_nakupy.sql
-- Nákupní seznam zakázky po výhře. Jeden řádek odpovídá jednomu indexu
-- položky v product-match.json; stav objednání se při opakovaném seedu zachovává.

CREATE TABLE IF NOT EXISTS crm_nakupy (
  id                       SERIAL PRIMARY KEY,
  tender_id                TEXT NOT NULL,
  polozka_index            INTEGER NOT NULL,
  polozka_nazev            TEXT,
  mnozstvi                 NUMERIC,
  jednotka                 TEXT,
  nakupni_cena_bez_dph     NUMERIC,
  dodavatel                TEXT,
  url                      TEXT,
  objednano                BOOLEAN NOT NULL DEFAULT FALSE,
  objednano_at             TIMESTAMPTZ,
  poznamka                 TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tender_id, polozka_index)
);

CREATE INDEX IF NOT EXISTS idx_crm_nakupy_tender
  ON crm_nakupy (tender_id, polozka_index);
