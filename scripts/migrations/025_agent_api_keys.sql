-- Agentni API klice: tajna hodnota se nikdy neuklada, pouze jeji SHA-256 hash.
-- Jeden klic predstavuje samostatnou agentni identitu s vlastnim dennim AI limitem.

CREATE TABLE IF NOT EXISTS agent_api_keys (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL CHECK (btrim(name) <> ''),
  purpose             TEXT NOT NULL CHECK (btrim(purpose) <> ''),
  key_hash            TEXT NOT NULL UNIQUE
                        CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  role                TEXT NOT NULL DEFAULT 'analytik'
                        CHECK (role IN ('analytik', 'viewer')),
  daily_limit_czk     NUMERIC(12, 2) NOT NULL
                        CHECK (daily_limit_czk >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ
);

-- Utrata je append-only. Stabilni charge_id dovoluje bezpecne zopakovat zapis po chybe
-- bez dvojiteho zauctovani stejneho AI volani.
CREATE TABLE IF NOT EXISTS agent_ai_spend (
  charge_id           TEXT PRIMARY KEY,
  agent_key_id        TEXT NOT NULL REFERENCES agent_api_keys(id),
  spent_on            DATE NOT NULL,
  amount_czk          NUMERIC(14, 6) NOT NULL CHECK (amount_czk >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_ai_spend_key_day
  ON agent_ai_spend (agent_key_id, spent_on);
