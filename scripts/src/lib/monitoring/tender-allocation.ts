import { mkdir, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function candidateName(baseSlug: string, feedId: string, attempt: number): string {
  if (attempt === 0) return baseSlug;
  if (attempt === 1) return `${baseSlug}-${feedId}`;
  return `${baseSlug}-${feedId}-${attempt}`;
}

/**
 * Atomicky rezervuje jméno zakázky vytvořením její input složky. Kolize v inputu
 * i cizí tender-meta.json v outputu vedou k dalšímu kandidátovi; existující metadata
 * se nikdy nepřepisují.
 */
export async function reserveMonitoringTender(
  inputDir: string,
  outputDir: string,
  baseSlug: string,
  feedId: string,
  metadata: unknown,
): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const tenderId = candidateName(baseSlug, feedId, attempt);
    const inputPath = join(inputDir, tenderId);

    try {
      // Bez recursive: právě tento mkdir je atomická rezervace jména.
      await mkdir(inputPath);
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) continue;
      throw error;
    }

    try {
      const tenderOutputDir = join(outputDir, tenderId);
      await mkdir(tenderOutputDir, { recursive: true });
      try {
        await writeFile(
          join(tenderOutputDir, 'tender-meta.json'),
          JSON.stringify(metadata, null, 2),
          { encoding: 'utf-8', flag: 'wx' },
        );
      } catch (error) {
        if (isErrorCode(error, 'EEXIST')) {
          // Output patří jiné zakázce. Uvolníme jen svou prázdnou input rezervaci.
          await rmdir(inputPath).catch(() => {});
          continue;
        }
        throw error;
      }
      return tenderId;
    } catch (error) {
      await rmdir(inputPath).catch(() => {});
      throw error;
    }
  }
}
