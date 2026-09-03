import {
  getPriceProvenanceGateReasons,
  isConcreteProductUrl,
  PriceOverrideSchema,
  PriceProvenanceSchema,
  type OvereniCeny,
  type PriceOverride,
  type PriceOverrideWrite,
  type PriceProvenance,
  type ProductCandidate,
  type ProductMatch,
} from './types.js';
import { candidateFingerprint } from './candidate-fingerprint.js';
import { selectCheapestRealPriceSource } from './price-reality.js';
import { validatePriceWrite, type ReviewIdentity } from './price-review.js';

export interface PriceConfirmationIssue {
  name: string;
  reasons: string[];
}

export interface UnconfirmedPrices {
  count: number;
  names: string[];
  issues: PriceConfirmationIssue[];
}

function confirmationIssue(
  name: string,
  priceOverride: ProductMatch['cenova_uprava'],
  now: Date | string,
): PriceConfirmationIssue | null {
  const reasons: string[] = [];
  if (priceOverride?.potvrzeno !== true) reasons.push('nemá potvrzenou cenu');
  reasons.push(...getPriceProvenanceGateReasons(priceOverride?.price_provenance, now).map((reason) => reason.message));
  return reasons.length > 0 ? { name, reasons } : null;
}

function confirmationResult(issues: PriceConfirmationIssue[]): UnconfirmedPrices {
  return {
    count: issues.length,
    names: issues.map((issue) => issue.name),
    issues,
  };
}

/**
 * Vrátí nepotvrzené ceny, které skutečně patří do podávaných částí zakázky.
 * Prázdný/neurčený výběr znamená všechny části. Funkce je čistá, aby stejný
 * money-gate používal API řetězec i přímé spuštění generate-bid.ts.
 */
export function findUnconfirmedPrices(
  productMatch: ProductMatch,
  selectedPartIds?: ReadonlySet<string> | null,
  now: Date | string = new Date(),
): UnconfirmedPrices {
  if (productMatch.polozky_match) {
    const relevant = productMatch.polozky_match.filter((item) => {
      if (!selectedPartIds || selectedPartIds.size === 0 || !item.cast_id) return true;
      return selectedPartIds.has(item.cast_id);
    });
    const issues = relevant
      .map((item) => confirmationIssue(item.polozka_nazev, item.cenova_uprava, now))
      .filter((issue): issue is PriceConfirmationIssue => issue !== null);
    return confirmationResult(issues);
  }

  const issue = confirmationIssue('cenová kalkulace', productMatch.cenova_uprava, now);
  return confirmationResult(issue ? [issue] : []);
}

/** Tvrdý gate: vyžaduje potvrzení i doložený, povolený a nepropadlý snapshot. */
export function assertPricesConfirmedForGeneration(
  productMatch: ProductMatch,
  selectedPartIds?: ReadonlySet<string> | null,
  now: Date | string = new Date(),
): void {
  const unconfirmed = findUnconfirmedPrices(productMatch, selectedPartIds, now);
  if (unconfirmed.count > 0) {
    const details = unconfirmed.issues
      .map((issue) => `${issue.name}: ${issue.reasons.join('; ')}`)
      .join(' | ');
    throw new Error(
      `Generování nelze spustit nad cenami bez platného potvrzení a dokladu (${unconfirmed.count}): ${details}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Autoritativní serverový zápis ceny
// ---------------------------------------------------------------------------

/** Minimální společný tvar kořenové a řádkové cenové entity. */
export interface ServerPriceTarget {
  kandidati?: ProductCandidate[];
  vybrany_index?: number;
  mnozstvi?: number;
  cenova_uprava?: PriceOverride;
  overeni_ceny?: OvereniCeny;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function moneyEqual(left: unknown, right: unknown): boolean {
  const a = finiteNumber(left);
  const b = finiteNumber(right);
  return a !== null && b !== null && Math.abs(a - b) < 0.011;
}

function currentCandidate(target: ServerPriceTarget): { candidate: ProductCandidate; index: number; fingerprint: string } {
  const candidates = target.kandidati;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('Potvrzenou cenu nelze svázat s aktuálním kandidátem.');
  }
  const requestedIndex = target.vybrany_index;
  const index = Number.isInteger(requestedIndex)
    && (requestedIndex as number) >= 0
    && (requestedIndex as number) < candidates.length
    ? requestedIndex as number
    : 0;
  const candidate = candidates[index];
  if (!candidate || typeof candidate.vyrobce !== 'string' || typeof candidate.model !== 'string') {
    throw new Error('Aktuální kandidát nemá identitu potřebnou pro cenový fingerprint.');
  }
  return { candidate, index, fingerprint: candidateFingerprint(candidate, index) };
}

function eligibleStoredSnapshot(
  value: unknown,
  fingerprint: string,
  requestedUrl: string | null,
  now: string,
): PriceProvenance | null {
  const parsed = PriceProvenanceSchema.safeParse(value);
  if (!parsed.success || parsed.data.kandidat_fingerprint !== fingerprint) return null;
  if (requestedUrl && parsed.data.url !== requestedUrl) return null;
  return getPriceProvenanceGateReasons(parsed.data, now).length === 0 ? parsed.data : null;
}

function verifiedSnapshotFromStoredFinding(
  target: ServerPriceTarget,
  fingerprint: string,
  requestedUrl: string | null,
  input: Record<string, unknown>,
): PriceProvenance | null {
  const verification = target.overeni_ceny;
  if (!verification || !requestedUrl
    || verification.kandidat_fingerprint !== fingerprint
    || (verification.stav !== 'nalezeno' && verification.stav !== 'ekvivalent')) return null;

  const source = verification.zdroje?.find((candidate) => (
    candidate.url === requestedUrl
    && candidate.orientacni !== true
    && isConcreteProductUrl(candidate.url)
  ));
  if (!source) return null;

  // Odkaz z requestu slouží jen jako klíč do serverem uloženého nálezu.
  // Cena musí odpovídat jeho přepočtu na požadované množství.
  const selected = selectCheapestRealPriceSource([source], target.mnozstvi || 1);
  if (!selected || !moneyEqual(selected.unitPriceWithoutVat, input.nakupni_cena_bez_dph)) return null;

  const rate = finiteNumber(source.sazba_dph);
  const packageSize = finiteNumber(source.baleni_ks);
  if (rate === null || rate < 0 || packageSize === null || packageSize <= 0) return null;
  let net = finiteNumber(source.cena_bez_dph);
  let gross = finiteNumber(source.cena_baleni_s_dph ?? source.cena_s_dph);
  if (net === null && gross !== null) net = Math.round((gross / (1 + rate / 100)) * 100) / 100;
  if (gross === null && net !== null) gross = Math.round(net * (1 + rate / 100) * 100) / 100;
  if (net === null || gross === null || net < 0 || gross < 0) return null;

  const parsed = PriceProvenanceSchema.safeParse({
    verze: 1,
    typ: 'overeny_eshop',
    stav: 'dolozena',
    url: source.url,
    zjisteno_at: verification.overeno_at,
    cena_v_okamziku: {
      bez_dph: net,
      s_dph: gross,
      mena: 'CZK',
      sazba_dph: rate,
      baleni_ks: packageSize,
    },
    zjistil: { typ: 'web_agent', id: 'price-verifier' },
    ...(source.dodavatel?.trim() ? { dodavatel: source.dodavatel.trim() } : {}),
    kandidat_fingerprint: fingerprint,
    ...(source.poznamka?.trim() ? { poznamka: source.poznamka.trim() } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function manualSnapshot(
  input: Record<string, unknown>,
  fingerprint: string,
  requestedUrl: string | null,
  documentReference: string | null,
  identity: ReviewIdentity | undefined,
  reviewedAt: string,
): PriceProvenance {
  const net = finiteNumber(input.nakupni_cena_bez_dph);
  const gross = finiteNumber(input.nakupni_cena_s_dph);
  if (net === null || gross === null) throw new Error('Lidský cenový vstup musí obsahovat číselnou cenu bez DPH i s DPH.');
  const rate = net > 0 ? Math.round(((gross / net) - 1) * 10_000) / 100 : 0;
  const purchaseSource = record(input.zdroj_nakupu);
  const actorId = identity?.sub?.trim() || identity?.name?.trim() || 'lokalni-operator';
  const actorName = identity?.name?.trim();

  return PriceProvenanceSchema.parse({
    verze: 1,
    typ: 'lidsky_vstup',
    stav: 'dolozena',
    url: requestedUrl,
    ...(documentReference ? { doklad_ref: documentReference } : {}),
    zjisteno_at: reviewedAt,
    cena_v_okamziku: {
      bez_dph: net,
      s_dph: gross,
      mena: 'CZK',
      sazba_dph: rate,
      baleni_ks: 1,
    },
    zjistil: {
      typ: 'uzivatel',
      id: actorId,
      ...(actorName ? { jmeno: actorName } : {}),
    },
    ...(typeof purchaseSource?.dodavatel === 'string' && purchaseSource.dodavatel.trim()
      ? { dodavatel: purchaseSource.dodavatel.trim() }
      : {}),
    kandidat_fingerprint: fingerprint,
    poznamka: 'Cenu a přiložený doklad výslovně potvrdil uživatel.',
  });
}

/**
 * Jediný validátor pro serverové cenové endpointy. Klientský snapshot i auditní
 * identitu vždy zahodí. Při potvrzení znovu sestaví provenance z uloženého
 * kandidáta/ověření, nebo z explicitní lidské URL či doklad_ref.
 */
export function validateServerPriceWrite(
  body: unknown,
  target: ServerPriceTarget,
  identity: ReviewIdentity | undefined,
  reviewedAt = new Date().toISOString(),
): PriceOverrideWrite {
  const raw = record(body);
  if (!raw) throw new Error('Cenový zápis musí být objekt.');
  const input = { ...raw };
  const documentReference = typeof input.doklad_ref === 'string' && input.doklad_ref.trim()
    ? input.doklad_ref.trim()
    : null;
  delete input.doklad_ref;
  // Nikdy nepřebírat klientem deklarovaný typ/stav/identitu provenience.
  delete input.price_provenance;

  if (input.potvrzeno !== true) {
    return PriceOverrideSchema.parse(validatePriceWrite(input, identity, reviewedAt));
  }

  const source = record(input.zdroj_nakupu);
  const sourceUrlValue = source?.url;
  if (sourceUrlValue !== undefined && !isConcreteProductUrl(sourceUrlValue)) {
    throw new Error('Doklad ceny musí odkazovat na konkrétní produktovou stránku, ne na vyhledávání.');
  }
  const requestedUrl = typeof sourceUrlValue === 'string' ? sourceUrlValue.trim() : null;
  const { candidate, fingerprint } = currentCandidate(target);

  let provenance = eligibleStoredSnapshot(
    target.cenova_uprava?.price_provenance,
    fingerprint,
    requestedUrl,
    reviewedAt,
  );
  if (provenance && target.cenova_uprava
    && (!moneyEqual(target.cenova_uprava.nakupni_cena_bez_dph, input.nakupni_cena_bez_dph)
      || !moneyEqual(target.cenova_uprava.nakupni_cena_s_dph, input.nakupni_cena_s_dph))) {
    provenance = null;
  }

  if (!provenance) {
    provenance = eligibleStoredSnapshot(candidate.price_provenance, fingerprint, requestedUrl, reviewedAt);
    if (provenance
      && (!moneyEqual(candidate.cena_bez_dph, input.nakupni_cena_bez_dph)
        || !moneyEqual(candidate.cena_s_dph, input.nakupni_cena_s_dph))) {
      provenance = null;
    }
  }

  provenance ??= verifiedSnapshotFromStoredFinding(target, fingerprint, requestedUrl, input);
  if (!provenance) {
    if (!requestedUrl && !documentReference) {
      throw new Error('Potvrzený lidský vstup vyžaduje konkrétní URL nebo doklad_ref; klientská provenience nestačí.');
    }
    provenance = manualSnapshot(
      input,
      fingerprint,
      requestedUrl,
      documentReference,
      identity,
      reviewedAt,
    );
  }

  return PriceOverrideSchema.parse(validatePriceWrite({ ...input, price_provenance: provenance }, identity, reviewedAt));
}
