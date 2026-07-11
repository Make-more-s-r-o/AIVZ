const MAX_DESCRIPTION_LENGTH = 1500;
const MIN_MEANINGFUL_LENGTH = 10;

interface ParsedDescription {
  title: string;
  description: string;
  sourceLength: number;
}

interface EnrichablePolozka {
  nazev: string;
  specifikace: string;
  cast_id?: string | null;
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*•\s*/g, '\n• ')
    .trim();
}

function capDescription(value: string): string {
  if (value.length <= MAX_DESCRIPTION_LENGTH) return value;
  return `${value.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

function parseVariant(rawVariant: string): ParsedDescription | null {
  const variant = rawVariant.trim().replace(/^\|\s*|\s*\|$/g, '').trim();
  if (!variant) return null;

  const firstNewline = variant.search(/[\r\n]/);
  const firstBullet = variant.indexOf('•');
  const firstColon = variant.indexOf(':');
  const structuralBreaks = [firstNewline, firstBullet].filter((index) => index >= 0);
  const firstStructuralBreak = structuralBreaks.length > 0
    ? Math.min(...structuralBreaks)
    : -1;
  const colonEndsTitle = firstColon >= 0
    && (
      (firstBullet >= 0 && firstColon < firstBullet)
      || (firstBullet < 0 && (firstNewline < 0 || firstColon < firstNewline))
    );
  const titleEnd = colonEndsTitle ? firstColon : firstStructuralBreak;
  if (titleEnd < 0) return null;

  const title = normalizeWhitespace(variant.slice(0, titleEnd));
  const descriptionStart = colonEndsTitle ? titleEnd + 1 : titleEnd;
  const description = normalizeWhitespace(variant.slice(descriptionStart));
  if (!title || description.length < MIN_MEANINGFUL_LENGTH) return null;

  return {
    title,
    description: capDescription(description),
    sourceLength: description.length,
  };
}

function parsePolozkaDescriptionRecords(text: string): Map<number, ParsedDescription> {
  const records = new Map<number, ParsedDescription>();
  if (!text) return records;

  const blockRe = /Polo[žz]ka\s*č\.?\s*(\d+)([\s\S]*?)(?=Polo[žz]ka\s*č\.?\s*\d+|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(text)) !== null) {
    const number = Number.parseInt(match[1], 10);
    const variants = match[2].split(/\s+\|\s+/);
    let bestInBlock: ParsedDescription | null = null;

    for (const rawVariant of variants) {
      const parsed = parseVariant(rawVariant);
      if (parsed && (!bestInBlock || parsed.sourceLength > bestInBlock.sourceLength)) {
        bestInBlock = parsed;
      }
    }

    const current = records.get(number);
    if (bestInBlock && (!current || bestInBlock.sourceLength > current.sourceLength)) {
      records.set(number, bestInBlock);
    }
  }

  return records;
}

/**
 * Vytáhne věcné popisy z bloků „Položka č. N“ bez jejich nadpisů. V produkčním
 * případu n-485400 (zejména položka 42) extrakce sloučených buněk opakovala tentýž
 * blok několikrát a kratší kopie bývaly oříznuté, proto deterministicky vítězí
 * nejdelší varianta a výsledek je omezen kvůli velikosti navazujícího promptu.
 */
export function parsePolozkaDescriptions(text: string): Map<number, string> {
  return new Map(
    [...parsePolozkaDescriptionRecords(text)].map(([number, record]) => [number, record.description]),
  );
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function itemNamePart(value: string): string {
  const colonIndex = value.indexOf(':');
  const vizMatch = /\bviz\b/i.exec(value);
  const cutIndexes = [colonIndex, vizMatch?.index ?? -1].filter((index) => index >= 0);
  return cutIndexes.length > 0 ? value.slice(0, Math.min(...cutIndexes)) : value;
}

function isPoorSpecification(value: string | undefined): boolean {
  const specification = value?.trim() ?? '';
  return specification.length < 30
    || /viz\s+(popis|p[řr][íi]loha|specifikace)/i.test(specification);
}

function stripSeeDescriptionPhrase(value: string | undefined): string {
  return (value ?? '')
    .replace(/(?:^|[\s:;,.-])viz\s+popis\s+n[ií][žz]e\b[\s:;,.-]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Doplní jen chudé specifikace a pouze tehdy, když číslo i začátek názvu souhlasí.
 * Názvový guard je zásadní pro vícedílné zakázky s opakovaným číslováním: u závazné
 * nabídky je cizí specifikace horší než žádná. Právě chybějící popis položky 42
 * v prod případu n-485400 vedl k halucinovanému produktu za řádově vyšší cenu.
 */
export function enrichPolozkySpecifikace(
  polozky: EnrichablePolozka[],
  texts: string[],
): number {
  const descriptions = new Map<number, ParsedDescription>();

  for (const text of texts) {
    for (const [number, candidate] of parsePolozkaDescriptionRecords(text)) {
      const current = descriptions.get(number);
      if (!current || candidate.sourceLength > current.sourceLength) {
        descriptions.set(number, candidate);
      }
    }
  }

  let enriched = 0;
  for (let index = 0; index < polozky.length; index++) {
    const polozka = polozky[index];
    if (!isPoorSpecification(polozka.specifikace)) continue;

    const itemNumber = index + 1;
    const block = descriptions.get(itemNumber);
    if (!block) continue;

    const normalizedItemName = normalizeName(itemNamePart(polozka.nazev));
    const normalizedBlockTitle = normalizeName(block.title);
    const requiredPrefix = normalizedItemName.slice(0, Math.min(8, normalizedItemName.length));
    if (!requiredPrefix || !normalizedBlockTitle.includes(requiredPrefix)) {
      console.warn(
        `  Desc enrichment skipped item ${itemNumber}: name mismatch "${polozka.nazev}" vs "${block.title}".`,
      );
      continue;
    }

    const original = stripSeeDescriptionPhrase(polozka.specifikace);
    polozka.specifikace = [original, block.description].filter(Boolean).join('\n').trim();
    enriched++;
  }

  return enriched;
}
