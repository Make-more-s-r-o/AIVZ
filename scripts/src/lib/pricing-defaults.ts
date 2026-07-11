/**
 * Výchozí marže pro cenové potvrzení v UI (pricing defaults).
 *
 * Stejný resolve řetězec jako v match-product.ts: firma přiřazená zakázce →
 * default firma → legacy config/company.json. Nikdy nevyhazuje — jde o UI
 * default, ne o kritická data; při jakékoli chybě vrací fallback
 * resolveDefaultMarzeProcent (10 %).
 *
 * Logika je oddělená od serve-api.ts, aby šel kontrakt otestovat bez spuštění
 * serveru (stejný vzor jako winprice-api.ts).
 */
import { readFile } from 'fs/promises';
import { join } from 'path';

import {
  getCompany as getCompanyFromStore,
  getTenderCompanyId as getTenderCompanyIdFromStore,
  resolveDefaultMarzeProcent,
  type CompanyData,
} from './company-store.js';

const ROOT = new URL('../../../', import.meta.url).pathname;

export interface PricingDefaults {
  default_marze_procent: number;
}

export interface PricingDefaultsDeps {
  getTenderCompanyId: (tenderId: string) => Promise<string | null>;
  getCompany: (id: string) => Promise<CompanyData | null>;
  /** Legacy config/company.json — poslední fallback, může chybět (→ reject/null). */
  readLegacyCompany: () => Promise<Pick<CompanyData, 'default_marze_procent'> | null>;
}

const defaultDeps: PricingDefaultsDeps = {
  getTenderCompanyId: getTenderCompanyIdFromStore,
  getCompany: getCompanyFromStore,
  readLegacyCompany: async () =>
    JSON.parse(await readFile(join(ROOT, 'config', 'company.json'), 'utf-8')),
};

/** Vyřeší výchozí marži pro zakázku. Vždy resolvuje (nikdy nereject-uje). */
export async function resolvePricingDefaults(
  tenderId: string,
  deps: PricingDefaultsDeps = defaultDeps,
): Promise<PricingDefaults> {
  try {
    const companyId = await deps.getTenderCompanyId(tenderId);
    const company = (companyId ? await deps.getCompany(companyId) : null)
      ?? await deps.getCompany('default')
      ?? await deps.readLegacyCompany().catch(() => null);
    return { default_marze_procent: resolveDefaultMarzeProcent(company?.default_marze_procent) };
  } catch {
    // Chyba resolveru nesmí shodit UI default — vrať bezpečný fallback (10 %).
    return { default_marze_procent: resolveDefaultMarzeProcent(undefined) };
  }
}
