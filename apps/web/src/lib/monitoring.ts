import type { MonitoringKategorie } from './api';

/** Jednotná česká taxonomie pro nastavení i operátorský feed. */
export const MONITORING_CATEGORIES: Array<{ value: MonitoringKategorie; label: string }> = [
  { value: 'it_av', label: 'IT a audiovizuální technika' },
  { value: 'naradi_dilna', label: 'Nářadí a dílna' },
  { value: 'zdravotnicke', label: 'Zdravotnické vybavení' },
  { value: 'vozidla', label: 'Vozidla' },
  { value: 'stavebni_prace', label: 'Stavební práce' },
  { value: 'potraviny', label: 'Potraviny' },
  { value: 'energie', label: 'Energie' },
  { value: 'nabytek', label: 'Nábytek' },
  { value: 'kancelar', label: 'Kancelářské potřeby' },
  { value: 'sluzby', label: 'Služby' },
  { value: 'ostatni', label: 'Ostatní' },
];

export const MONITORING_CATEGORY_LABEL = Object.fromEntries(
  MONITORING_CATEGORIES.map((category) => [category.value, category.label]),
) as Record<MonitoringKategorie, string>;
