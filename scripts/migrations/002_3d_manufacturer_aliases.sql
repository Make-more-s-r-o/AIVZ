-- 002_3d_manufacturer_aliases.sql
-- Rozšíření aliasů výrobců pro 3D tisk značky + Prusa data source

-- Prusa e-shop jako datový zdroj (id=6)
INSERT INTO data_sources (name, type, base_url) VALUES
  ('Prusa e-shop', 'eshop', 'https://www.prusa3d.cz')
ON CONFLICT (name) DO NOTHING;

-- Aliasy 3D tisk značek
INSERT INTO manufacturer_aliases (canonical_name, alias) VALUES
  ('Bambu Lab', 'BambuLab'),
  ('Bambu Lab', 'BAMBU LAB'),
  ('Anycubic', 'ANYCUBIC'),
  ('Elegoo', 'ELEGOO'),
  ('Creality', 'CREAlity'),
  ('Flashforge', 'FLASHFORGE'),
  ('Raise3D', 'Raise 3D'),
  ('eSUN', 'ESUN'),
  ('Polymaker', 'POLYMAKER'),
  ('Fillamentum', 'FILLAMENTUM'),
  ('ColorFabb', 'COLORFABB'),
  ('Fiberlogy', 'FIBERLOGY'),
  ('Spectrum', 'SPECTRUM'),
  ('Prusament', 'PRUSAMENT'),
  ('Bambu Lab', 'Bambu'),
  ('Anycubic', 'Anycubic 3D'),
  ('Elegoo', 'Elegoo 3D'),
  ('Creality', 'Ender'),
  ('Zortrax', 'ZORTRAX'),
  ('Formlabs', 'FORMLABS'),
  ('Phrozen', 'PHROZEN')
ON CONFLICT (alias) DO NOTHING;
