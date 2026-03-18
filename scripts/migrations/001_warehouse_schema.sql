-- 001_warehouse_schema.sql
-- Cenový sklad (Product Warehouse) — hlavní schema
-- Vytvořeno: 2026-03-18

-- Rozšíření
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- Kategorie produktů (hierarchické)
-- ============================================================
CREATE TABLE product_categories (
  id        SERIAL PRIMARY KEY,
  slug      TEXT UNIQUE NOT NULL,
  nazev     TEXT NOT NULL,
  parent_id INTEGER REFERENCES product_categories(id),
  ikona     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Definice parametrů per kategorie
-- ============================================================
CREATE TABLE parameter_definitions (
  id            SERIAL PRIMARY KEY,
  category_slug TEXT NOT NULL,
  param_key     TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  data_type     TEXT NOT NULL CHECK (data_type IN ('integer','decimal','text','boolean')),
  unit          TEXT,
  filter_type   TEXT DEFAULT 'range' CHECK (filter_type IN ('range','enum','boolean','text')),
  enum_values   TEXT[],
  is_required   BOOLEAN DEFAULT false,
  sort_order    INTEGER DEFAULT 0,
  aliasy        TEXT[] DEFAULT '{}',
  UNIQUE(category_slug, param_key)
);

-- ============================================================
-- Synonymy parametrů pro import normalizaci
-- ============================================================
CREATE TABLE parameter_synonyms (
  id              SERIAL PRIMARY KEY,
  canonical_key   TEXT NOT NULL,
  synonym         TEXT NOT NULL UNIQUE,
  regex_pattern   TEXT,
  conversion_func TEXT
);

-- ============================================================
-- Aliasy výrobců
-- ============================================================
CREATE TABLE manufacturer_aliases (
  id             SERIAL PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  alias          TEXT NOT NULL UNIQUE
);

-- ============================================================
-- Datové zdroje (musí existovat před products kvůli FK)
-- ============================================================
CREATE TABLE data_sources (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL CHECK (type IN ('eshop','distribution','manual','api','apify')),
  base_url       TEXT,
  scraper_config JSONB DEFAULT '{}',
  is_active      BOOLEAN DEFAULT TRUE,
  last_scraped_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Produkty — dual-layer parametry (raw + normalized JSONB)
-- ============================================================
CREATE TABLE products (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer          TEXT NOT NULL,
  model                 TEXT NOT NULL,
  ean                   TEXT,
  part_number           TEXT,
  category_id           INTEGER REFERENCES product_categories(id),
  product_family        TEXT,
  description           TEXT,
  raw_description       TEXT,
  parameters            JSONB DEFAULT '{}',
  parameters_normalized JSONB DEFAULT '{}',
  embedding             vector(1536),
  image_url             TEXT,
  hmotnost_kg           DECIMAL(8,3),
  zaruka_mesice         INTEGER,
  is_active             BOOLEAN DEFAULT TRUE,
  zdroj_dat             TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),

  -- Generated columns
  model_normalized TEXT GENERATED ALWAYS AS (
    lower(regexp_replace(regexp_replace(model, '\s+', ' ', 'g'), '(?i)\bgen\s*', 'G', 'g'))
  ) STORED,

  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(manufacturer,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(model,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(part_number,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description,'')), 'C')
  ) STORED,

  search_text TEXT GENERATED ALWAYS AS (
    coalesce(manufacturer,'') || ' ' || coalesce(model,'') || ' ' ||
    coalesce(part_number,'') || ' ' || coalesce(description,'')
  ) STORED
);

-- Deduplikační indexy (EAN > MPN > manufacturer+model)
CREATE UNIQUE INDEX idx_products_ean ON products (ean) WHERE ean IS NOT NULL;
CREATE UNIQUE INDEX idx_products_mpn ON products (manufacturer, part_number)
  WHERE part_number IS NOT NULL;
CREATE UNIQUE INDEX idx_products_mfr_model ON products (lower(manufacturer), model_normalized)
  WHERE part_number IS NULL AND ean IS NULL;

-- Search indexy
CREATE INDEX idx_products_search ON products USING GIN (search_vector);
CREATE INDEX idx_products_trgm ON products USING GIN (search_text gin_trgm_ops);
CREATE INDEX idx_products_embedding ON products USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);
CREATE INDEX idx_products_params ON products USING GIN (parameters_normalized jsonb_path_ops);
CREATE INDEX idx_products_category ON products (category_id);
CREATE INDEX idx_products_family ON products (product_family) WHERE product_family IS NOT NULL;

-- JSONB partial expression indexy (pro časté parametry)
CREATE INDEX idx_param_ram ON products (((parameters_normalized->>'ram_gb')::numeric))
  WHERE parameters_normalized ? 'ram_gb';
CREATE INDEX idx_param_ssd ON products (((parameters_normalized->>'ssd_gb')::numeric))
  WHERE parameters_normalized ? 'ssd_gb';

-- ============================================================
-- Aktuální ceny (1 řádek per produkt+zdroj, UPSERT)
-- ============================================================
CREATE TABLE product_prices_current (
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_id     INTEGER NOT NULL REFERENCES data_sources(id),
  price_bez_dph NUMERIC(12,2) NOT NULL,
  price_s_dph   NUMERIC(12,2),
  currency      TEXT DEFAULT 'CZK',
  availability  TEXT,
  stock_quantity INTEGER,
  delivery_days  INTEGER,
  source_url    TEXT,
  source_sku    TEXT,
  fetched_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (product_id, source_id)
);

-- ============================================================
-- Cenová historie (delta-only)
-- ============================================================
CREATE TABLE product_prices_history (
  id            BIGSERIAL PRIMARY KEY,
  product_id    UUID NOT NULL,
  source_id     INTEGER NOT NULL,
  price_bez_dph NUMERIC(12,2) NOT NULL,
  price_s_dph   NUMERIC(12,2),
  availability  TEXT,
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_price_history_product ON product_prices_history (product_id, valid_from DESC);

-- ============================================================
-- Scraping joby
-- ============================================================
CREATE TABLE scrape_jobs (
  id              SERIAL PRIMARY KEY,
  source_id       INTEGER NOT NULL REFERENCES data_sources(id),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','done','error','cancelled')),
  query           TEXT,
  category_slug   TEXT,
  items_found     INTEGER DEFAULT 0,
  items_new       INTEGER DEFAULT 0,
  items_updated   INTEGER DEFAULT 0,
  items_price_changed INTEGER DEFAULT 0,
  errors          JSONB DEFAULT '[]',
  duration_ms     INTEGER,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Feedback loop: matchování zakázek → produkty
-- ============================================================
CREATE TABLE tender_product_matches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id         TEXT NOT NULL,
  polozka_nazev     TEXT NOT NULL,
  product_id        UUID REFERENCES products(id),
  match_method      TEXT NOT NULL CHECK (match_method IN ('exact','text','vector','ai_estimate','manual')),
  match_score       NUMERIC(5,2),
  price_offered     NUMERIC(12,2),
  was_winning_bid   BOOLEAN,
  user_confirmed    BOOLEAN DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Dodavatelé per produkt
-- ============================================================
CREATE TABLE product_suppliers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_name     TEXT NOT NULL,
  supplier_sku      TEXT,
  purchase_price    NUMERIC(12,2),
  currency          TEXT DEFAULT 'CZK',
  min_order_qty     INTEGER DEFAULT 1,
  delivery_days     INTEGER,
  in_stock          BOOLEAN,
  url               TEXT,
  last_updated      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, supplier_name)
);

-- ============================================================
-- View: nejlepší cena per produkt
-- ============================================================
CREATE VIEW v_best_prices AS
SELECT DISTINCT ON (product_id)
  product_id, source_id, price_bez_dph, price_s_dph, availability, source_url, fetched_at
FROM product_prices_current
ORDER BY product_id, price_bez_dph ASC;

-- ============================================================
-- Funkce: vyhledávání v kategorii a podkategoriích
-- ============================================================
CREATE OR REPLACE FUNCTION get_category_tree(root_id INTEGER)
RETURNS TABLE(id INTEGER) AS $$
  WITH RECURSIVE tree AS (
    SELECT pk.id FROM product_categories pk WHERE pk.id = root_id
    UNION ALL
    SELECT pk.id FROM product_categories pk JOIN tree ON pk.parent_id = tree.id
  )
  SELECT id FROM tree;
$$ LANGUAGE sql STABLE;

-- ============================================================
-- Seed: kategorie
-- ============================================================
INSERT INTO product_categories (slug, nazev, parent_id, ikona) VALUES
  ('it_hardware',       'IT Hardware',              NULL, 'monitor'),
  ('notebook',          'Notebooky',                1,    'laptop'),
  ('server',            'Servery',                  1,    'server'),
  ('monitor',           'Monitory',                 1,    'monitor'),
  ('tiskarna',          'Tiskárny',                 1,    'printer'),
  ('sitove_prvky',      'Síťové prvky',             1,    'network'),
  ('pc_desktop',        'Stolní počítače',          1,    'monitor'),
  ('uloziste',          'Úložiště / NAS',           1,    'hard-drive'),
  ('av',                'AV technika',              NULL, 'projector'),
  ('projektor',         'Projektory',               9,    'projector'),
  ('interaktivni_tabule','Interaktivní tabule',     9,    'tablet'),
  ('audio',             'Audio technika',           9,    'speaker'),
  ('3d_tisk',           '3D tisk',                  NULL, 'box'),
  ('fdm_printer',       'FDM tiskárny',             13,   'box'),
  ('sla_printer',       'SLA/DLP tiskárny',         13,   'box'),
  ('material_3d',       '3D materiály',             13,   'package'),
  ('nabytek',           'Nábytek',                  NULL, 'armchair'),
  ('stul',              'Stoly',                    17,   'table'),
  ('zidle',             'Židle',                    17,   'armchair'),
  ('skrin',             'Skříně a regály',          17,   'archive'),
  ('nastroje',          'Nástroje',                 NULL, 'wrench'),
  ('rucni_naradi',      'Ruční nářadí',             21,   'wrench'),
  ('elektro_naradi',    'Elektro nářadí',           21,   'zap'),
  ('kancelarsky_material','Kancelářský materiál',   NULL, 'file-text'),
  ('papir',             'Papír',                    24,   'file-text'),
  ('tonery',            'Tonery a cartridge',       24,   'printer'),
  ('software',          'Software',                 NULL, 'code'),
  ('licence_perpetual', 'Trvalé licence',           27,   'key'),
  ('licence_subscription','Předplatné',             27,   'refresh-cw');

-- ============================================================
-- Seed: definice parametrů pro hlavní kategorie
-- ============================================================

-- Notebooky
INSERT INTO parameter_definitions (category_slug, param_key, display_name, data_type, unit, filter_type, is_required, sort_order, aliasy) VALUES
  ('notebook', 'cpu_model',      'Procesor',          'text',    NULL,  'text',    true,  1,  '{"CPU","Processor","Procesor"}'),
  ('notebook', 'ram_gb',         'RAM',               'integer', 'GB',  'range',   true,  2,  '{"Operační paměť","Memory","Paměť RAM","RAM"}'),
  ('notebook', 'ram_type',       'Typ RAM',           'text',    NULL,  'enum',    false, 3,  '{"Typ paměti"}'),
  ('notebook', 'ssd_gb',         'SSD',               'integer', 'GB',  'range',   true,  4,  '{"Disk","Úložiště","Storage","SSD"}'),
  ('notebook', 'display_size',   'Displej',           'decimal', '"',   'range',   true,  5,  '{"Úhlopříčka","Obrazovka","Screen"}'),
  ('notebook', 'display_res',    'Rozlišení',         'text',    NULL,  'enum',    false, 6,  '{"Resolution"}'),
  ('notebook', 'gpu',            'Grafická karta',    'text',    NULL,  'text',    false, 7,  '{"GPU","Graphics"}'),
  ('notebook', 'os',             'Operační systém',   'text',    NULL,  'enum',    false, 8,  '{"OS","Windows","Systém"}'),
  ('notebook', 'battery_wh',     'Baterie',           'decimal', 'Wh',  'range',   false, 9,  '{"Kapacita baterie"}'),
  ('notebook', 'weight_kg',      'Hmotnost',          'decimal', 'kg',  'range',   false, 10, '{"Váha","Weight"}');

-- Servery
INSERT INTO parameter_definitions (category_slug, param_key, display_name, data_type, unit, filter_type, is_required, sort_order, aliasy) VALUES
  ('server', 'cpu_model',        'Procesor',          'text',    NULL,  'text',    true,  1,  '{"CPU","Processor"}'),
  ('server', 'cpu_count',        'Počet CPU',         'integer', NULL,  'range',   false, 2,  '{"Počet procesorů"}'),
  ('server', 'ram_gb',           'RAM',               'integer', 'GB',  'range',   true,  3,  '{"Operační paměť","Memory"}'),
  ('server', 'disk_type',        'Typ disku',         'text',    NULL,  'enum',    false, 4,  '{"Storage type"}'),
  ('server', 'disk_capacity_tb', 'Kapacita disku',    'decimal', 'TB',  'range',   false, 5,  '{"Disk","Úložiště"}'),
  ('server', 'form_factor',      'Form factor',       'text',    NULL,  'enum',    false, 6,  '{"Provedení","Rack/Tower"}'),
  ('server', 'psu_w',            'Zdroj',             'integer', 'W',   'range',   false, 7,  '{"Napájení","PSU"}');

-- 3D tiskárny (FDM)
INSERT INTO parameter_definitions (category_slug, param_key, display_name, data_type, unit, filter_type, is_required, sort_order, aliasy) VALUES
  ('fdm_printer', 'build_x_mm',       'Tiskový prostor X', 'integer', 'mm', 'range',  true,  1,  '{"Build volume X","Šířka tisku"}'),
  ('fdm_printer', 'build_y_mm',       'Tiskový prostor Y', 'integer', 'mm', 'range',  true,  2,  '{"Build volume Y","Hloubka tisku"}'),
  ('fdm_printer', 'build_z_mm',       'Tiskový prostor Z', 'integer', 'mm', 'range',  true,  3,  '{"Build volume Z","Výška tisku"}'),
  ('fdm_printer', 'nozzle_temp_max',  'Max teplota trysky', 'integer', '°C', 'range', false, 4,  '{"Nozzle temp","Teplota extruderu"}'),
  ('fdm_printer', 'bed_temp_max',     'Max teplota podložky','integer','°C', 'range', false, 5,  '{"Bed temp","Teplota desky"}'),
  ('fdm_printer', 'layer_min_mm',     'Min výška vrstvy',  'decimal', 'mm', 'range',  false, 6,  '{"Layer height","Rozlišení"}'),
  ('fdm_printer', 'filament_diameter','Průměr filamentu',   'decimal', 'mm', 'enum',   false, 7,  '{"Filament","Materiál"}'),
  ('fdm_printer', 'enclosed',         'Uzavřená komora',   'boolean', NULL,  'boolean',false, 8,  '{"Enclosed","Kryt"}'),
  ('fdm_printer', 'dual_extruder',    'Dual extruder',     'boolean', NULL,  'boolean',false, 9,  '{"Dva extrudery"}');

-- Projektory
INSERT INTO parameter_definitions (category_slug, param_key, display_name, data_type, unit, filter_type, is_required, sort_order, aliasy) VALUES
  ('projektor', 'lumens',          'Svítivost',         'integer', 'lm',   'range',  true,  1,  '{"ANSI lumen","Brightness","Jas"}'),
  ('projektor', 'resolution',      'Rozlišení',         'text',    NULL,   'enum',   true,  2,  '{"Nativní rozlišení","Resolution"}'),
  ('projektor', 'contrast_ratio',  'Kontrast',          'text',    NULL,   'text',   false, 3,  '{"Kontrastní poměr"}'),
  ('projektor', 'technology',      'Technologie',       'text',    NULL,   'enum',   false, 4,  '{"DLP","LCD","Laser","LED"}'),
  ('projektor', 'throw_ratio',     'Projekční poměr',   'decimal', NULL,   'range',  false, 5,  '{"Throw ratio"}'),
  ('projektor', 'lamp_life_h',     'Životnost lampy',   'integer', 'h',    'range',  false, 6,  '{"Lamp life","Životnost zdroje"}'),
  ('projektor', 'hdmi_count',      'HDMI porty',        'integer', NULL,   'range',  false, 7,  '{"HDMI"}'),
  ('projektor', 'weight_kg',       'Hmotnost',          'decimal', 'kg',   'range',  false, 8,  '{"Váha","Weight"}');

-- Monitory
INSERT INTO parameter_definitions (category_slug, param_key, display_name, data_type, unit, filter_type, is_required, sort_order, aliasy) VALUES
  ('monitor', 'display_size',    'Úhlopříčka',        'decimal', '"',   'range',  true,  1,  '{"Obrazovka","Displej","Screen"}'),
  ('monitor', 'resolution',      'Rozlišení',         'text',    NULL,  'enum',   true,  2,  '{"Resolution","Nativní rozlišení"}'),
  ('monitor', 'panel_type',      'Typ panelu',        'text',    NULL,  'enum',   false, 3,  '{"IPS","VA","TN","OLED"}'),
  ('monitor', 'refresh_rate_hz', 'Obnovovací frekvence','integer','Hz', 'range',  false, 4,  '{"Refresh rate","Hz"}'),
  ('monitor', 'response_time_ms','Odezva',            'decimal', 'ms',  'range',  false, 5,  '{"Response time"}'),
  ('monitor', 'brightness_nits', 'Jas',               'integer', 'nits','range',  false, 6,  '{"Brightness","cd/m²"}'),
  ('monitor', 'usb_c_pd',        'USB-C Power Delivery','boolean',NULL, 'boolean',false, 7,  '{"USB-C PD","Thunderbolt"}'),
  ('monitor', 'pivot',           'Pivot',             'boolean', NULL,  'boolean',false, 8,  '{"Otočení","Height adjust"}');

-- Seed: datové zdroje (výchozí)
INSERT INTO data_sources (name, type, base_url) VALUES
  ('Ruční import', 'manual', NULL),
  ('Alza.cz', 'eshop', 'https://www.alza.cz'),
  ('CZC.cz', 'eshop', 'https://www.czc.cz'),
  ('Heureka.cz', 'eshop', 'https://www.heureka.cz'),
  ('Mironet.cz', 'eshop', 'https://www.mironet.cz');

-- Seed: aliasy výrobců
INSERT INTO manufacturer_aliases (canonical_name, alias) VALUES
  ('HP', 'Hewlett-Packard'),
  ('HP', 'Hewlett Packard'),
  ('HP', 'HPE'),
  ('HP', 'HP Inc.'),
  ('Lenovo', 'LENOVO'),
  ('Dell', 'DELL'),
  ('Dell', 'Dell Technologies'),
  ('Epson', 'EPSON'),
  ('Canon', 'CANON'),
  ('Brother', 'BROTHER'),
  ('Samsung', 'SAMSUNG'),
  ('LG', 'LG Electronics'),
  ('Asus', 'ASUS'),
  ('Acer', 'ACER'),
  ('Microsoft', 'MICROSOFT'),
  ('Apple', 'APPLE'),
  ('Prusa', 'Prusa Research'),
  ('Prusa', 'PRUSA'),
  ('Creality', 'CREALITY'),
  ('BenQ', 'BENQ'),
  ('ViewSonic', 'VIEWSONIC');

-- Seed: synonymy parametrů
INSERT INTO parameter_synonyms (canonical_key, synonym, regex_pattern) VALUES
  ('ram_gb',        'Operační paměť',     '(\d+)\s*GB'),
  ('ram_gb',        'RAM',                '(\d+)\s*GB'),
  ('ram_gb',        'Memory',             '(\d+)\s*GB'),
  ('ram_gb',        'Paměť RAM',          '(\d+)\s*GB'),
  ('ssd_gb',        'SSD',                '(\d+)\s*[GT]B'),
  ('ssd_gb',        'Disk',               '(\d+)\s*[GT]B'),
  ('ssd_gb',        'Úložiště',           '(\d+)\s*[GT]B'),
  ('ssd_gb',        'Storage',            '(\d+)\s*[GT]B'),
  ('display_size',  'Úhlopříčka',         '(\d+[.,]\d+)\s*"'),
  ('display_size',  'Obrazovka',          '(\d+[.,]\d+)\s*"'),
  ('cpu_model',     'Procesor',           NULL),
  ('cpu_model',     'CPU',                NULL),
  ('cpu_model',     'Processor',          NULL),
  ('weight_kg',     'Hmotnost',           '(\d+[.,]?\d*)\s*kg'),
  ('weight_kg',     'Váha',              '(\d+[.,]?\d*)\s*kg');
