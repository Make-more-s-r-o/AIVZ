import { basename, extname, join } from 'node:path';
import { open, unlink } from 'node:fs/promises';

import type { NenAttachment } from './nen-client.js';
import { fetchAllowedNenUrl, isAllowedNenUrl } from './nen-client.js';
import type { HlidacTenderDocument } from './hlidac-client.js';

/**
 * SSRF pojistka pro přílohy z Hlídače státu — ten agreguje dokumenty z různých
 * profilů zadavatelů, ne jen z NEN. Zatím ověřeno reálně jen proti TenderArena
 * (`api.tenderarena.cz`, 2026-07-14); další hostitele profilů přidávat sem
 * teprve po ověření reálné URL, ne dopředu naslepo.
 */
const ALLOWED_HLIDAC_DOC_HOSTS = new Set(['api.tenderarena.cz']);

export function isAllowedHlidacDocUrl(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return url.protocol === 'https:'
      && ALLOWED_HLIDAC_DOC_HOSTS.has(url.hostname)
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

/** Limity stahování příloh ZD — pojistka proti runaway zakázce / DoS. */
export const MAX_ZD_FILES = 30;
export const MAX_ZD_FILE_BYTES = 50 * 1024 * 1024; // 50 MB / soubor
export const MAX_ZD_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB celkem

/** Povolené přípony — shodné s multer fileFilter / document-parser vstupem. */
export const ALLOWED_ZD_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.xls', '.xlsx', '.zip']);

const ZD_REQUEST_TIMEOUT_MS = 60_000;

const CONTENT_TYPE_EXTENSIONS = new Map<string, string>([
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/zip', '.zip'],
]);

export interface DownloadZdResult {
  pocet_stazenych: number;
  varovani: string[];
}

export interface DownloadZdOptions {
  fetchFn?: typeof fetch;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/** Automatika smí pokračovat jen po úplném a bezchybném stažení celé nalezené sady. */
export function shouldAutoStartDownloadedPipeline(
  found: number,
  downloaded: number,
  warnings: readonly string[],
): boolean {
  return found > 0 && downloaded === found && warnings.length === 0;
}

export function incompleteDownloadWarning(downloaded: number, found: number): string {
  return `staženo ${downloaded}/${found} — pipeline nespuštěna, zkontrolujte dokumenty a spusťte ručně`;
}

export const AI_JOBS_DISABLED_MONITORING_WARNING = 'AI joby jsou vypnuté v Governance';

/** Měkký governance guard: zakázka zůstává převzatá, zakáže se pouze enqueue pipeline. */
export function monitoringAutoStartGovernanceDecision(aiJobsEnabled: boolean): {
  spustit: boolean;
  varovani: string | null;
} {
  return aiJobsEnabled
    ? { spustit: true, varovani: null }
    : { spustit: false, varovani: AI_JOBS_DISABLED_MONITORING_WARNING };
}

class DownloadLimitError extends Error {
  constructor(
    message: string,
    readonly kind: 'file' | 'total',
  ) {
    super(message);
  }
}

function declaredContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Zapíše webový stream po částech a průběžně hlídá oba bajtové limity. */
async function streamResponseToFile(
  response: Response,
  path: string,
  controller: AbortController,
  maxFileBytes: number,
  remainingTotalBytes: number,
): Promise<number> {
  if (!response.body) return 0;
  const handle = await open(path, 'w');
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxFileBytes) {
        controller.abort();
        await reader.cancel().catch(() => {});
        throw new DownloadLimitError('překročen limit velikosti souboru', 'file');
      }
      if (bytes > remainingTotalBytes) {
        controller.abort();
        await reader.cancel().catch(() => {});
        throw new DownloadLimitError('překročen souhrnný limit', 'total');
      }
      await handle.write(value);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Očistí zobrazovaný název přílohy na bezpečný basename pro zápis do `input/<id>/`.
 * Zahodí adresářové komponenty (path traversal), řídicí znaky a `..`. Vrací `null`,
 * když je název nepoužitelný nebo přípona není v allowlistu.
 */
function sanitizeAttachmentBaseName(rawName: string): string | null {
  if (!rawName) return null;
  // basename ořízne POSIX i Windows oddělovače (…/ , …\).
  let name = basename(rawName.replace(/\\/g, '/')).trim();
  // Odstraň řídicí znaky a znaky nepřípustné v názvech souborů.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').trim();
  if (!name || name === '.' || name === '..') return null;
  if (name.includes('..')) return null;
  return name;
}

export function sanitizeAttachmentName(rawName: string): string | null {
  const name = sanitizeAttachmentBaseName(rawName);
  if (!name) return null;
  const ext = extname(name).toLowerCase();
  if (!ALLOWED_ZD_EXTENSIONS.has(ext)) return null;
  return name;
}

/** Vytáhne parametr hlavičky Content-Disposition včetně quoted-string varianty. */
function dispositionParameter(header: string, parameter: string): string | null {
  const escaped = parameter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?:^|;)\\s*${escaped}\\s*=\\s*(?:"((?:\\\\.|[^"])*)"|([^;]*))`, 'i');
  const match = regex.exec(header);
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value ? value.replace(/\\(["\\])/g, '$1') : null;
}

/** Preferuje RFC 5987 filename*=UTF-8''… a při chybě použije běžný filename=. */
function contentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const extended = dispositionParameter(header, 'filename*');
  if (extended) {
    const match = /^([^']*)'[^']*'(.*)$/.exec(extended);
    if (match && match[1].toLowerCase() === 'utf-8') {
      try {
        return decodeURIComponent(match[2]);
      } catch {
        // Poškozené filename* nesmí zablokovat použitelný fallback filename.
      }
    }
  }
  return dispositionParameter(header, 'filename');
}

function responseContentType(response: Response): string | null {
  const value = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  return value || null;
}

function nameWithExtension(rawName: string, extension: string): string | null {
  const baseName = sanitizeAttachmentBaseName(rawName);
  if (!baseName) return null;
  const currentExtension = extname(baseName);
  const stem = currentExtension ? baseName.slice(0, -currentExtension.length) : baseName;
  return sanitizeAttachmentName(`${stem}${extension}`);
}

interface ResolvedAttachmentName {
  name: string | null;
  reason?: string;
}

/** Určí bezpečný název v pořadí: odkaz, Content-Disposition, Content-Type. */
function resolveAttachmentName(attachmentName: string, response: Response): ResolvedAttachmentName {
  const fromLink = sanitizeAttachmentName(attachmentName);
  if (fromLink) return { name: fromLink };

  const dispositionName = contentDispositionFilename(response.headers.get('content-disposition'));
  const fromDisposition = dispositionName ? sanitizeAttachmentName(dispositionName) : null;
  if (fromDisposition) return { name: fromDisposition };

  const contentType = responseContentType(response);
  const inferredExtension = contentType ? CONTENT_TYPE_EXTENSIONS.get(contentType) : undefined;
  if (inferredExtension) {
    const inferredName = nameWithExtension(dispositionName || attachmentName, inferredExtension);
    return inferredName ? { name: inferredName } : { name: null, reason: 'chybí název' };
  }

  const unsupportedExtension = extname(dispositionName || attachmentName).toLowerCase();
  const unsupportedType = contentType || unsupportedExtension;
  if (unsupportedType) return { name: null, reason: `nepodporovaný typ ${unsupportedType}` };
  return sanitizeAttachmentBaseName(dispositionName || attachmentName)
    ? { name: null, reason: 'nepodporovaný typ neuvedený' }
    : { name: null, reason: 'chybí název' };
}

/** Zajistí jedinečnost názvu ve složce (přidá `-2`, `-3` … před příponu). */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) {
    used.add(name.toLowerCase());
    return name;
  }
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

interface UrlGuard {
  /** Lidsky čitelný popis zamítnutého zdroje v hlášce (např. „mimo nen.nipez.cz"). */
  odmitnutiDuvod: string;
  isAllowed(url: string): boolean;
  fetchAllowed(url: string, fetchFn: typeof fetch, init: RequestInit): Promise<Response>;
}

const NEN_GUARD: UrlGuard = {
  odmitnutiDuvod: 'mimo nen.nipez.cz',
  isAllowed: isAllowedNenUrl,
  fetchAllowed: fetchAllowedNenUrl,
};

const HLIDAC_GUARD: UrlGuard = {
  odmitnutiDuvod: 'mimo ověřené profily zadavatelů',
  isAllowed: isAllowedHlidacDocUrl,
  async fetchAllowed(url, fetchFn, init) {
    if (!isAllowedHlidacDocUrl(url)) throw new Error(`nepovolená URL přílohy: ${url}`);
    return fetchFn(url, init);
  },
};

/**
 * Stáhne přílohy ZD do cílové složky. Robustní vůči selhání jednotlivého souboru
 * (zaloguje varování a pokračuje). Vynucuje limity: max počet souborů, max velikost
 * jednoho souboru i souhrnná velikost. Vrací počet úspěšně stažených + varování.
 */
async function downloadAttachments(
  attachments: NenAttachment[],
  destDir: string,
  guard: UrlGuard,
  options: DownloadZdOptions = {},
): Promise<DownloadZdResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const maxFiles = options.maxFiles ?? MAX_ZD_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_ZD_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ZD_TOTAL_BYTES;

  const varovani: string[] = [];
  const usedNames = new Set<string>();
  let pocet_stazenych = 0;
  let totalBytes = 0;

  for (const attachment of attachments) {
    if (pocet_stazenych >= maxFiles) {
      varovani.push(`Dosažen limit ${maxFiles} souborů — zbývající přílohy nebyly staženy.`);
      break;
    }

    const displayName = attachment.nazev || 'bez názvu';
    if (!guard.isAllowed(attachment.url)) {
      varovani.push(`Příloha „${displayName}" přeskočena (nepovolená URL ${guard.odmitnutiDuvod}).`);
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ZD_REQUEST_TIMEOUT_MS);
    let filePath: string | null = null;
    let safeName: string | null = sanitizeAttachmentName(attachment.nazev);
    try {
      const response = await guard.fetchAllowed(attachment.url, fetchFn, {
        headers: { 'User-Agent': 'vz-ai-tool/monitoring' },
        signal: controller.signal,
      });
      if (!response.ok) {
        controller.abort();
        await response.body?.cancel().catch(() => {});
        varovani.push(`Přílohu „${displayName}" se nepodařilo stáhnout (HTTP ${response.status}).`);
        continue;
      }

      const resolved = resolveAttachmentName(attachment.nazev, response);
      safeName = resolved.name;
      if (!safeName) {
        controller.abort();
        await response.body?.cancel().catch(() => {});
        varovani.push(`Příloha „${displayName}" přeskočena (${resolved.reason ?? 'chybí název'}).`);
        continue;
      }

      const contentLength = declaredContentLength(response);
      if (contentLength === 0) {
        controller.abort();
        await response.body?.cancel().catch(() => {});
        varovani.push(`Příloha „${safeName}" je prázdná — přeskočena.`);
        continue;
      }
      if (contentLength != null && contentLength > maxFileBytes) {
        controller.abort();
        await response.body?.cancel().catch(() => {});
        varovani.push(
          `Příloha „${safeName}" (${Math.round(contentLength / 1024 / 1024)} MB) překračuje limit ${Math.round(maxFileBytes / 1024 / 1024)} MB — přeskočena.`,
        );
        continue;
      }
      if (contentLength != null && totalBytes + contentLength > maxTotalBytes) {
        controller.abort();
        await response.body?.cancel().catch(() => {});
        varovani.push(
          `Souhrnný limit ${Math.round(maxTotalBytes / 1024 / 1024)} MB dosažen — „${safeName}" a další přílohy nebyly staženy.`,
        );
        break;
      }

      const finalName = uniqueName(safeName, usedNames);
      filePath = join(destDir, finalName);
      const downloadedBytes = await streamResponseToFile(
        response,
        filePath,
        controller,
        maxFileBytes,
        maxTotalBytes - totalBytes,
      );
      if (downloadedBytes === 0) {
        await unlink(filePath).catch(() => {});
        filePath = null;
        varovani.push(`Příloha „${safeName}" je prázdná — přeskočena.`);
        continue;
      }
      totalBytes += downloadedBytes;
      pocet_stazenych += 1;
    } catch (error) {
      if (filePath) await unlink(filePath).catch(() => {});
      if (error instanceof DownloadLimitError) {
        if (error.kind === 'file') {
          varovani.push(`Příloha „${safeName}" překročila limit velikosti během stahování — částečný soubor byl smazán.`);
        } else {
          varovani.push(`Souhrnný limit dosažen během stahování „${safeName}" — částečný soubor byl smazán.`);
          break;
        }
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      varovani.push(`Přílohu „${safeName ?? displayName}" se nepodařilo stáhnout (${message}).`);
    } finally {
      clearTimeout(timeout);
    }
  }

  return { pocet_stazenych, varovani };
}

export function downloadNenAttachments(
  attachments: NenAttachment[],
  destDir: string,
  options: DownloadZdOptions = {},
): Promise<DownloadZdResult> {
  return downloadAttachments(attachments, destDir, NEN_GUARD, options);
}

/**
 * Stáhne přílohy ZD nalezené přes detail Hlídače státu (viz fetchHlidacTenderDocuments).
 * Hlídač agreguje víc zdrojů než NEN — proto vlastní SSRF allowlist (ALLOWED_HLIDAC_DOC_HOSTS).
 */
export function downloadHlidacAttachments(
  attachments: HlidacTenderDocument[],
  destDir: string,
  options: DownloadZdOptions = {},
): Promise<DownloadZdResult> {
  return downloadAttachments(attachments, destDir, HLIDAC_GUARD, options);
}
