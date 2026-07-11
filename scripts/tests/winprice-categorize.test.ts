import { strict as assert } from 'node:assert';
import test from 'node:test';

import { categorizeCommodity, KOMODITA_KATEGORIE_VALUES } from '../src/lib/winprice-store.js';

// Reálné příklady předmětů plnění z veřejných zakázek — pokrývají všechny kategorie
// a několik záměrných kolizí (3D tiskárna vs. IT tiskárna, sanitka vs. vozidla, ...).
const CASES: Array<[string, string]> = [
  // it_av
  ['Dodávka serverů pro datové centrum', 'it_av'],
  ['Nákup 20 ks notebooků s příslušenstvím', 'it_av'],
  ['Dataprojektor s příslušenstvím pro učebnu', 'it_av'],
  ['Diskové pole pro virtualizační cluster', 'it_av'],
  ['Server s diskovým polem a UPS', 'it_av'],
  ['Laserová tiskárna barevná A4', 'it_av'],
  ['Wi-Fi přístupové body pro školu', 'it_av'],
  // naradi_dilna
  ['Elektrická vrtačka příklepová', 'naradi_dilna'],
  ['Svářečka CO2 pro dílnu', 'naradi_dilna'],
  ['Vakuová balička pro dílnu', 'naradi_dilna'],
  ['Elektrocentrála 5kW', 'naradi_dilna'],
  ['3D tiskárna pro výuku technických předmětů', 'naradi_dilna'], // priority override proti it_av "tiskárna"
  ['CNC frézka pro strojírenskou dílnu', 'naradi_dilna'],
  // zdravotnicke
  ['Rentgenový přístroj pro radiodiagnostiku', 'zdravotnicke'],
  ['Ultrazvukový přístroj pro gynekologii', 'zdravotnicke'],
  ['CT přístroj pro nemocnici', 'zdravotnicke'],
  ['Sanitní vozidlo typu C', 'zdravotnicke'], // priorita před vozidla (dřívější v pořadí)
  ['Stomatologická souprava pro zubní ordinaci', 'zdravotnicke'],
  // vozidla
  ['Osobní automobil kategorie M1', 'vozidla'],
  ['Nákladní automobil s hydraulickou rukou', 'vozidla'],
  ['Traktor s příslušenstvím pro údržbu zeleně', 'vozidla'],
  // stavebni_prace
  ['Rekonstrukce střechy základní školy', 'stavebni_prace'],
  ['Stavební úpravy tělocvičny', 'stavebni_prace'],
  ['Výstavba nové tělocvičny', 'stavebni_prace'],
  ['Zateplení fasády bytového domu', 'stavebni_prace'],
  // potraviny
  ['Dodávka potravin do školní jídelny', 'potraviny'],
  ['Dodávka pečiva pro školní jídelnu', 'potraviny'],
  // energie
  ['Dodávka zemního plynu pro rok 2027', 'energie'],
  ['Dodávka pohonných hmot - nafta', 'energie'],
  ['Sdružené služby dodávky elektřiny', 'energie'],
  // nabytek
  ['Kancelářské židle, 50 ks', 'nabytek'],
  ['Konferenční stůl a sedací souprava', 'nabytek'],
  ['Nábytek do školní jídelny - stoly a židle', 'nabytek'],
  ['Kancelářský nábytek - skříně a stoly', 'nabytek'], // specifičtější než obecné "kancelář"
  // kancelar
  ['Kancelářský papír A4, 80g', 'kancelar'],
  ['Kancelářské potřeby - toner, papír, desky', 'kancelar'],
  ['Skartovačka dokumentů', 'kancelar'],
  // sluzby
  ['Úklidové služby v budově úřadu', 'sluzby'],
  ['Právní poradenství a zastupování', 'sluzby'],
  ['Ostraha objektu - bezpečnostní služba', 'sluzby'],
  ['Konzultační poradenství v oblasti kybernetické bezpečnosti', 'sluzby'],
  // ostatni (fallback — nic nematchne)
  ['Umělecké dílo - socha do parku', 'ostatni'],
];

for (const [predmet, expected] of CASES) {
  test(`categorizeCommodity: "${predmet}" → ${expected}`, () => {
    assert.equal(categorizeCommodity(predmet), expected);
  });
}

test('kategorizace je case-insensitive a nezávislá na diakritice', () => {
  assert.equal(categorizeCommodity('SERVER PRO DATOVÉ CENTRUM'), 'it_av');
  assert.equal(categorizeCommodity('server pro datove centrum'), 'it_av');
});

test('prázdný/nesmyslný předmět spadne do ostatni', () => {
  assert.equal(categorizeCommodity(''), 'ostatni');
  assert.equal(categorizeCommodity('xyz123'), 'ostatni');
});

test('KOMODITA_KATEGORIE_VALUES obsahuje všechny reálné výstupy categorizeCommodity', () => {
  for (const [predmet] of CASES) {
    assert.ok(KOMODITA_KATEGORIE_VALUES.includes(categorizeCommodity(predmet)));
  }
});
