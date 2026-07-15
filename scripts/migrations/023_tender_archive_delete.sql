-- Archivace + soft-delete zakázky.
-- Zakázka není řádek v DB (je to složka input/output/{id}); její jediný per-zakázka
-- záznam je crm_tender_status. Archivace i soft-delete se proto ukládají sem jako
-- nullable timestamps (+ kdo akci provedl). Trvalé smazání (purge) řeší aplikace
-- ručním úklidem napříč všemi tender_id tabulkami (žádné FK CASCADE).

ALTER TABLE crm_tender_status
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by  TEXT;

-- Partial indexy: seznam zakázek filtruje "není smazané / není archivované".
CREATE INDEX IF NOT EXISTS idx_cts_deleted  ON crm_tender_status (deleted_at)  WHERE deleted_at  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cts_archived ON crm_tender_status (archived_at) WHERE archived_at IS NOT NULL;
