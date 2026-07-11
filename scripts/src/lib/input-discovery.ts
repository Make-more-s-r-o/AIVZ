import { readdir, readFile, mkdir, writeFile, rm, stat } from 'fs/promises';
import { join, extname, basename, sep, relative, resolve } from 'path';
import PizZip from 'pizzip';
import { ZIP_PEEK_SIZE_LIMIT_BYTES } from './upload-limits.js';

/**
 * Robustní discovery vstupních souborů zakázky.
 *
 * Reálné zakázky nechodí jako plochý adresář — bývají to vnořené složky
 * (input/"Robota "/…), případně ZIP se zadávací dokumentací
 * (input/"VARY&TE …"/Zadávací dokumentace - komplet.zip). Původní `readdir()`
 * viděl jen první úroveň → z takové zakázky pipeline nevytáhla nic.
 *
 * Tento modul:
 *  - rekurzivně projde podadresáře (limit hloubky + max souborů),
 *  - transparentně rozbalí ZIP (a 1 úroveň vnořeného ZIPu) do pracovní složky
 *    `input/<tender>/.extracted/` (gitignore),
 *  - odfiltruje šum (__MACOSX, .DS_Store, Thumbs.db, LibreOffice ~$ zámky, 0 B),
 *  - deduplikuje stejný soubor (název+velikost) z více míst,
 *  - při kolizi jmen (stejný název, jiný obsah) prefixuje display name relativní cestou.
 *
 * BEZPEČNOST:
 *  - zip-slip ochrana: žádná entry nesmí zapsat mimo cílovou složku,
 *  - cap na celkovou rozbalenou velikost (default ~500 MB) — obrana proti zip bombě.
 */

/** Název pracovní složky pro rozbalené ZIPy (relativně k inputDir). Gitignorováno. */
export const EXTRACTED_DIRNAME = '.extracted';

export interface DiscoveredFile {
  /** Absolutní cesta k souboru (na disku — i uvnitř .extracted/). */
  absPath: string;
  /** Cesta relativní k inputDir (POSIX-ish, pro logy a řešení kolizí). */
  relPath: string;
  /**
   * Zobrazovaný název souboru pro downstream (isTemplate/isSoupis/pattern match).
   * Běžně basename; při kolizi basenamů napříč složkami relativní cesta,
   * aby se dva různé soubory téhož jména nepřepsaly/nezaměnily.
   */
  name: string;
  /** Velikost v bajtech. */
  size: number;
  /** true, pokud soubor pochází z rozbaleného ZIPu. */
  fromZip: boolean;
}

export interface DiscoverOptions {
  /** Max hloubka zanoření adresářů (0 = jen kořen). Default 5. */
  maxDepth?: number;
  /** Max počet souborů, které se vůbec zváží. Default 500. */
  maxFiles?: number;
  /** Cap na součet rozbalených bajtů ze všech ZIPů. Default 500 MB. */
  maxExtractedBytes?: number;
  /** Kolik úrovní vnořených ZIPů rozbalovat (0 = jen top-level ZIP). Default 1. */
  maxZipDepth?: number;
}

const DEFAULTS: Required<DiscoverOptions> = {
  maxDepth: 5,
  maxFiles: 500,
  maxExtractedBytes: 500 * 1024 * 1024,
  maxZipDepth: 1,
};

/** Adresáře/soubory, které se při procházení ignorují (šum). */
function isNoiseName(name: string): boolean {
  if (name === '__MACOSX') return true;
  if (name === '.DS_Store') return true;
  if (name === 'Thumbs.db' || name === 'thumbs.db') return true;
  // LibreOffice/MS Office zámkové/temp soubory: "~$Něco.xlsx"
  if (name.startsWith('~$')) return true;
  return false;
}

/** Interní stav jednoho discovery běhu. */
interface Ctx {
  opts: Required<DiscoverOptions>;
  inputDir: string;
  /** Kořen pro rozbalené ZIPy: inputDir/.extracted */
  extractRoot: string;
  /** Kandidáti (před dedup + přiřazením display name). */
  raw: Array<{ absPath: string; relPath: string; size: number; fromZip: boolean }>;
  /** Kolik souborů už bylo zváženo (proti maxFiles). */
  considered: number;
  /** Součet rozbalených bajtů (proti maxExtractedBytes). */
  extractedBytes: number;
  /** Kolik ZIPů se pro unikátní jméno extrahovalo — pro unikátní cílové složky. */
  zipCounter: number;
  /** Varování k vypsání do logu. */
  warnings: string[];
}

/**
 * Bezpečně rozbalí jeden ZIP buffer do `destDir`.
 * Vrací seznam zapsaných souborů. Aplikuje zip-slip ochranu i velikostní cap.
 */
async function extractZipBuffer(
  buffer: Buffer,
  destDir: string,
  ctx: Ctx
): Promise<Array<{ absPath: string; size: number }>> {
  let zip: PizZip;
  try {
    zip = new PizZip(buffer);
  } catch (err) {
    ctx.warnings.push(`Nelze otevřít ZIP (poškozený?): ${err}`);
    return [];
  }

  const written: Array<{ absPath: string; size: number }> = [];
  const destResolved = resolve(destDir);

  for (const entryName of Object.keys(zip.files)) {
    const entry = zip.files[entryName];
    if (entry.dir) continue;

    const base = basename(entryName);
    // Šum uvnitř ZIPu: __MACOSX/…, .DS_Store, ~$… — přeskočit celé cesty.
    if (entryName.split('/').some((seg) => isNoiseName(seg)) || isNoiseName(base)) continue;

    // ZIP-SLIP ochrana: cílová cesta musí zůstat uvnitř destDir.
    const target = resolve(destDir, entryName);
    if (target !== destResolved && !target.startsWith(destResolved + sep)) {
      ctx.warnings.push(`ZIP-slip zablokován: entry "${entryName}" míří mimo cíl (přeskočeno)`);
      continue;
    }

    let content: Buffer;
    try {
      content = entry.asNodeBuffer();
    } catch (err) {
      ctx.warnings.push(`Nelze přečíst entry "${entryName}" ze ZIPu: ${err}`);
      continue;
    }

    // 0 B soubory ignorujeme (šum, prázdné placeholdery).
    if (content.length === 0) continue;

    // Cap na celkovou rozbalenou velikost (obrana proti zip bombě).
    if (ctx.extractedBytes + content.length > ctx.opts.maxExtractedBytes) {
      ctx.warnings.push(
        `Cap na rozbalenou velikost (${Math.round(ctx.opts.maxExtractedBytes / 1024 / 1024)} MB) dosažen — zbytek ZIPu přeskočen`
      );
      break;
    }

    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
    ctx.extractedBytes += content.length;
    written.push({ absPath: target, size: content.length });
  }

  return written;
}

/**
 * Rekurzivně projde adresář. Při ZIPu ho rozbalí do .extracted/ a projde i to.
 * @param dir absolutní adresář k procházení
 * @param depth aktuální hloubka zanoření adresářů
 * @param zipDepth aktuální hloubka zanoření ZIPů (0 = mimo ZIP / top-level ZIP)
 */
async function walk(dir: string, depth: number, zipDepth: number, ctx: Ctx): Promise<void> {
  if (ctx.considered >= ctx.opts.maxFiles) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    ctx.warnings.push(`Nelze číst adresář "${dir}": ${err}`);
    return;
  }
  // Deterministické pořadí (napříč OS/FS).
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (ctx.considered >= ctx.opts.maxFiles) {
      ctx.warnings.push(`Limit ${ctx.opts.maxFiles} souborů dosažen — zbytek přeskočen`);
      return;
    }
    if (isNoiseName(entry.name)) continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      // .extracted procházíme jen když do ní sami rozbalujeme (voláno cíleně),
      // ne jako součást běžného stromu — jinak by se při re-run zdvojily soubory.
      if (dir === ctx.inputDir && entry.name === EXTRACTED_DIRNAME) continue;
      if (depth >= ctx.opts.maxDepth) {
        ctx.warnings.push(`Limit hloubky ${ctx.opts.maxDepth} — adresář přeskočen: ${full}`);
        continue;
      }
      await walk(full, depth + 1, zipDepth, ctx);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = extname(entry.name).toLowerCase();

    // ZIP: rozbalit a projít (pokud nejsme za limitem vnoření ZIPů).
    if (ext === '.zip') {
      if (zipDepth > ctx.opts.maxZipDepth) {
        ctx.warnings.push(`ZIP vnořený hlouběji než ${ctx.opts.maxZipDepth} úroveň — nerozbaluji: ${full}`);
        continue;
      }
      ctx.considered++;
      let buffer: Buffer;
      try {
        buffer = await readFile(full);
      } catch (err) {
        ctx.warnings.push(`Nelze přečíst ZIP "${full}": ${err}`);
        continue;
      }
      // Unikátní cílová složka: .extracted/<poradi>-<nazev bez pripony>
      const stem = basename(entry.name, extname(entry.name));
      const destDir = join(ctx.extractRoot, `${ctx.zipCounter++}-${stem}`);
      const written = await extractZipBuffer(buffer, destDir, ctx);
      // Rozbalené soubory projdeme jako běžný adresář (zvýší se zipDepth).
      if (written.length > 0) {
        await walk(destDir, depth, zipDepth + 1, ctx);
      }
      continue;
    }

    // Běžný soubor. Velikost (Dirent ji nenese) se doplní ve finalizaci přes stat,
    // aby dedup podle (název+velikost) fungoval.
    ctx.considered++;
    ctx.raw.push({
      absPath: full,
      relPath: relative(ctx.inputDir, full).split(sep).join('/'),
      size: -1,
      fromZip: zipDepth > 0,
    });
  }
}

/**
 * Rychlý náhled obsahu ZIPu BEZ rozbalení na disk — pro okamžitou UI odezvu po uploadu
 * ("archiv obsahuje N souborů"). Skutečné rozbalení (se zip-slip ochranou a cappem na
 * velikost) dělá až extract krok přes discoverInputFiles/extractZipBuffer výše.
 * Vrací null, když ZIP nejde otevřít (poškozený soubor) — volající to bere jako "neznámo".
 */
export function peekZipFileCount(buffer: Buffer): number | null {
  if (!shouldPeekZipFile(buffer.length)) return null;
  try {
    const zip = new PizZip(buffer);
    let count = 0;
    for (const entryName of Object.keys(zip.files)) {
      const entry = zip.files[entryName];
      if (entry.dir) continue;
      const base = basename(entryName);
      if (entryName.split('/').some((seg) => isNoiseName(seg)) || isNoiseName(base)) continue;
      count++;
    }
    return count;
  } catch {
    return null;
  }
}

/** Informativní ZIP náhled nad tímto limitem přeskočíme ještě před readFile. */
export function shouldPeekZipFile(sizeBytes: number): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes >= 0 && sizeBytes <= ZIP_PEEK_SIZE_LIMIT_BYTES;
}

/**
 * Hlavní vstupní bod. Vrátí deduplikovaný seznam relevantních souborů zakázky
 * (rekurzivně + z rozbalených ZIPů), s vyřešenými display names.
 */
export async function discoverInputFiles(
  inputDir: string,
  options: DiscoverOptions = {}
): Promise<{ files: DiscoveredFile[]; warnings: string[] }> {
  const opts = { ...DEFAULTS, ...options };
  const extractRoot = join(inputDir, EXTRACTED_DIRNAME);

  // Čistý start: staré rozbalené soubory smažeme (idempotence, žádné duchy z minula).
  await rm(extractRoot, { recursive: true, force: true });

  const ctx: Ctx = {
    opts,
    inputDir,
    extractRoot,
    raw: [],
    considered: 0,
    extractedBytes: 0,
    zipCounter: 0,
    warnings: [],
  };

  await walk(inputDir, 0, 0, ctx);

  // Doplnění velikostí (Dirent je nenese) — jednotně přes stat.
  for (const r of ctx.raw) {
    try {
      const st = await stat(r.absPath);
      r.size = st.size;
    } catch {
      r.size = 0;
    }
  }

  // Filtr 0 B souborů (šum).
  const nonEmpty = ctx.raw.filter((r) => r.size > 0);

  // Dedup: stejný (basename, size) = tentýž soubor → jednou.
  const seen = new Map<string, { absPath: string; relPath: string; size: number; fromZip: boolean }>();
  for (const r of nonEmpty) {
    const key = `${basename(r.relPath).toLowerCase()}|${r.size}`;
    if (!seen.has(key)) {
      seen.set(key, r);
    }
  }
  const unique = [...seen.values()];

  // Přiřazení display name: pokud stejný basename nesou 2+ RŮZNÉ soubory,
  // dostanou všechny relativní cestu (aby se nezaměnily); jinak čistý basename.
  const nameCounts = new Map<string, number>();
  for (const u of unique) {
    const b = basename(u.relPath).toLowerCase();
    nameCounts.set(b, (nameCounts.get(b) || 0) + 1);
  }

  const files: DiscoveredFile[] = unique.map((u) => {
    const b = basename(u.relPath);
    const collides = (nameCounts.get(b.toLowerCase()) || 0) > 1;
    return {
      absPath: u.absPath,
      relPath: u.relPath,
      // Při kolizi prefixujeme relativní cestou (separátory → " / " kvůli čitelnosti
      // a aby to zůstalo validní název; downstream používá substring/normalizaci).
      name: collides ? u.relPath.split('/').join(' / ') : b,
      size: u.size,
      fromZip: u.fromZip,
    };
  });

  // Stabilní pořadí výstupu.
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return { files, warnings: ctx.warnings };
}
