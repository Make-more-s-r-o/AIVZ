-- Migrace: přidání dalších e-shop zdrojů pro scraping systém
-- Prusa e-shop (source_id=6) už existuje z migrace 002

INSERT INTO data_sources (name, type, base_url) VALUES
  ('Filament PM', 'eshop', 'https://www.filament-pm.cz'),
  ('Smart3D', 'eshop', 'https://www.smart3d.cz'),
  ('3DJake', 'eshop', 'https://www.3djake.cz'),
  ('Majkl3D', 'eshop', 'https://www.majkl3d.cz')
ON CONFLICT (name) DO NOTHING;

-- Aliasy pro Prusa Research (doplnění)
INSERT INTO manufacturer_aliases (canonical_name, alias) VALUES
  ('Prusa Research', 'Prusa'),
  ('Prusa Research', 'PRUSA RESEARCH'),
  ('Prusa Research', 'PrusaResearch'),
  ('Prusa Research', 'Prusa 3D'),
  ('Prusa Research', 'Prusament')
ON CONFLICT (canonical_name, alias) DO NOTHING;
