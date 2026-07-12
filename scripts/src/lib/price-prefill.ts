/**
 * Předvyplnění cenova_uprava z vybraného AI kandidáta — vytaženo z match-product.ts
 * do čisté funkce bez side-effectů (kromě console.warn), aby šla logika testovat
 * bez AI volání a souborového systému.
 *
 * MONEY-PATH INVARIANT: kandidát bez reálné shody (zadna_shoda, placeholder název,
 * nulová/chybějící cena) NIKDY nedostane předvyplněnou cenu z AI odhadu. Dostane
 * nulovou nepotvrzenou cenu → nula spadne do HARD sanity flagu `zero_price`
 * (price-sanity.ts), takže potvrzení i podání jsou blokované, dokud operátor
 * nezadá reálnou cenu ručně. Reálný prod případ: položka „Rázová redukce 3/4"×1/2""
 * (adaptér ~200 Kč) dostala halucinovaného kandidáta „kompletní sada nářadí"
 * za 280 000 Kč — extrém chytil sanity gate, ale mírné přecenění 2–3× by prošlo.
 */
import { calculateItemPrice } from './price-calculator.js';

// Zástupná / prázdná hodnota názvu produktu (AI někdy vrátí „None", „-", prázdno místo reálného
// produktu). Kandidát bez reálného produktu NESMÍ dostat auto-předvyplněnou závaznou cenu k podání.
export function isPlaceholderProductName(value: unknown): boolean {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '' || v === '-' || v === '–' || v === '—' || v === 'none' || v === 'null' || v === 'n/a'
    || /^(neuveden[ýy]?|nezn[aá]m[ýy]?|bez zna[čc]ky|generick[ýy])$/i.test(v);
}

// Reálný produkt = má smysluplný model NEBO popis. Samotný výrobce nestačí (služby mají
// záměrně `vyrobce: '-'` a přesto jsou legitimní — jejich model je název služby).
export function candidateHasRealProduct(candidate: { vyrobce?: string; model?: string; popis?: string } | undefined): boolean {
  if (!candidate) return false;
  return !isPlaceholderProductName(candidate.model) || !isPlaceholderProductName(candidate.popis);
}

// Klíčová slova označující sadu/komplet — deterministický scale-mismatch guard.
// Položka = jednotlivý díl, ale kandidát vypadá jako sada → typická halucinace jiného
// rozsahu (prod: adaptér ~200 Kč vs. „kompletní sada nářadí" 280 000 Kč).
export const SADA_KEYWORDS = ['sada', 'sady', 'set', 'komplet', 'kufr', 'kit', 'souprava'];

// Porovnáváme CELÁ slova (tokeny), ne podřetězce — „Makita" obsahuje „kit",
// „headset" obsahuje „set" → substring match by dával falešné poplachy.
export function containsSadaKeyword(text: unknown): boolean {
  const tokens = String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9áčďéěíňóřšťúůýž]+/i)
    .filter(Boolean);
  return tokens.some((t) => SADA_KEYWORDS.includes(t));
}

const NO_MATCH_POZNAMKA =
  'BEZ NALEZENÉ SHODY — cena nenalezena, nutné ruční nacenění (AI nenašla odpovídající reálný produkt).';

const UNIDENTIFIED_CANDIDATE_POZNAMKA =
  'Kandidát není jednoznačně identifikován (chybí model i katalogové číslo) — nacenění vyžaduje ověřený zdroj nebo ruční cenu.';

const SCALE_MISMATCH_POZNAMKA =
  '⚠ Kandidát vypadá jako sada/komplet, ale položka je jednotlivý díl — zkontrolujte rozsah a cenu.';

// Minimální strukturální typy — prefill běží nad syrovými AI daty PŘED finální
// Zod validací (ProductMatchSchema), takže čísla mohou být ještě stringy.
export interface PrefillCandidate {
  vyrobce?: string;
  model?: string;
  popis?: string;
  cena_bez_dph?: number | string;
  cena_spolehlivost?: string;
  katalogove_cislo?: string;
  zadna_shoda?: boolean;
  [key: string]: unknown;
}

export interface PrefillItem {
  polozka_nazev?: string;
  typ?: string;
  kandidati?: PrefillCandidate[];
  vybrany_index?: number;
  cena_max_s_dph?: number | null;
  cenova_uprava?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Předvyplní `cenova_uprava` pro každou položku bez existující cenové úpravy.
 * Mutuje položky na místě (stejně jako původní inline smyčka v match-product.ts).
 * potvrzeno=false zůstává záměrně — závaznou cenu musí uživatel zkontrolovat (H3).
 */
export function applyPricePrefill(polozkyMatch: PrefillItem[], defaultMarze: number): void {
  for (const pm of polozkyMatch) {
    // Identita produktu přímo určuje důvěryhodnost AI ceny. Penalizujeme všechny
    // kandidáty, nejen vybraný, aby pozdější změna výběru nemohla obejít invariant.
    for (const candidate of pm.kandidati ?? []) {
      if (isPlaceholderProductName(candidate.model)) {
        candidate.cena_spolehlivost = 'nizka';
      } else if (
        isPlaceholderProductName(candidate.katalogove_cislo)
        && candidate.cena_spolehlivost === 'vysoka'
      ) {
        candidate.cena_spolehlivost = 'stredni';
      }
    }

    const selected = pm.kandidati?.[pm.vybrany_index ?? -1];
    if (!selected || pm.cenova_uprava) continue;

    // Deterministický scale-mismatch guard: název položky sadu NEzmiňuje, ale vybraný
    // kandidát (model+popis) ano → pravděpodobně navržen jiný rozsah. Cenu neměníme —
    // jen forceneme nízkou spolehlivost a varujeme (extrémy blokuje sanity gate).
    const scaleMismatch =
      !containsSadaKeyword(pm.polozka_nazev) &&
      containsSadaKeyword(`${selected.model ?? ''} ${selected.popis ?? ''}`);
    if (scaleMismatch) {
      selected.cena_spolehlivost = 'nizka';
      console.warn(`  ⚠ Scale mismatch: "${pm.polozka_nazev}" je jednotlivý díl, ale kandidát "${selected.vyrobce ?? ''} ${selected.model ?? ''}" vypadá jako sada/komplet — zkontrolujte rozsah a cenu.`);
    }

    // Bez reálné shody = zadna_shoda od AI, placeholder název produktu, nebo chybějící/
    // nekladná cena. Cena takového kandidáta je čirý AI odhad bez ověřeného produktu
    // (typicky halucinace jiného rozsahu) → NIKDY ji nepředvyplňujeme. Nulová
    // nepotvrzená cena spadne do HARD sanity flagu `zero_price`, takže potvrzení
    // i podání jsou blokované, dokud operátor nezadá reálnou cenu ručně.
    const noRealMatch =
      selected.zadna_shoda === true ||
      !candidateHasRealProduct(selected) ||
      !((selected.cena_bez_dph as number) > 0);
    const unidentifiedProduct =
      pm.typ !== 'sluzba' &&
      isPlaceholderProductName(selected.model) &&
      isPlaceholderProductName(selected.katalogove_cislo);
    if (noRealMatch || unidentifiedProduct) {
      const baseNote = unidentifiedProduct ? UNIDENTIFIED_CANDIDATE_POZNAMKA : NO_MATCH_POZNAMKA;
      pm.cenova_uprava = {
        nakupni_cena_bez_dph: 0,
        nakupni_cena_s_dph: 0,
        marze_procent: defaultMarze,
        nabidkova_cena_bez_dph: 0,
        nabidkova_cena_s_dph: 0,
        potvrzeno: false,
        poznamka: scaleMismatch ? `${baseNote} ${SCALE_MISMATCH_POZNAMKA}` : baseNote,
      };
      console.warn(unidentifiedProduct
        ? `  ⚠ Neidentifikovaný kandidát: "${pm.polozka_nazev}" — chybí model i katalogové číslo, cenu je nutné doložit nebo zadat ručně.`
        : `  ⚠ Bez nalezené shody: "${pm.polozka_nazev}" — cena nenalezena, nutné ruční nacenění.`);
      continue;
    }

    const bez = Number(selected.cena_bez_dph) || 0;
    const calculatedPrice = calculateItemPrice(bez, defaultMarze);
    const nabS = calculatedPrice.nabidkova_cena_s_dph;
    const cap = pm.cena_max_s_dph;
    const overCap = cap != null && nabS > cap;
    let poznamka = overCap
      ? `⚠ PŘEKRAČUJE STROP ${cap} Kč s DPH — uprav cenu. Cena z AI odhadu, nutné potvrzení.`
      : 'Cena z AI odhadu — zkontrolujte a potvrďte před podáním.';
    if (scaleMismatch) poznamka += ` ${SCALE_MISMATCH_POZNAMKA}`;
    pm.cenova_uprava = {
      ...calculatedPrice,
      potvrzeno: false,
      poznamka,
    };
    if (overCap) console.warn(`  ⚠ Cap exceeded: "${pm.polozka_nazev}" ${nabS} Kč s DPH > limit ${cap} Kč`);
  }
}
